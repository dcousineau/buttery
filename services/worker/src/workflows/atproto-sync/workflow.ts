import { ApplicationFailure, CancellationScope, ContinueAsNew, continueAsNew, isCancellation, log, proxyActivities, workflowInfo } from "@temporalio/workflow";
import type { AtprotoSyncActivities } from "#/workflows/atproto-sync/activities.ts";
import { emptySummary, foldRepo, windows } from "#/workflows/atproto-sync/plan.ts";
import type { AtprotoSyncInput, SweepContinuation, SweepSummary } from "#/workflows/atproto-sync/types.ts";

/**
 * Sweep the atproto network and reconcile the Postgres recipe index.
 *
 * Every `await` below is a point the run resumes from on a different machine. A
 * worker that dies mid-sweep does not restart the sweep: the next worker to pick
 * it up replays the history, sees which repos already completed, and carries on.
 *
 * Read this file as the whole algorithm. Everything it calls is an activity, and
 * every activity is a thin wrapper over `lib/` — see `activities.ts`.
 *
 * ## One repo is one activity
 *
 * `syncRepo` is called per DID rather than per batch, which makes the repo the
 * unit of three separate things: **retry** (a PDS that times out costs that repo
 * three attempts, not everyone else's work), **failure** (a repo that exhausts
 * them is counted and stepped over — an hourly sweep that failed whenever one of
 * thousands of servers was unreachable would simply always be failing), and
 * **distribution** (repos go through the task queue, so a fleet of workers
 * shares them instead of one worker looping alone).
 *
 * What it costs is history: roughly three events per repo, against a 10k-event
 * soft warning and a 50k hard cap. Hence `continueAsNew` below, which is the
 * whole reason this shape is safe at network scale.
 */

/** Enumeration: minutes of paging against a relay, so it heartbeats. */
const { enumerateRepos } = proxyActivities<AtprotoSyncActivities>({
  startToCloseTimeout: "20 minutes",
  // Without this, a worker killed mid-page is only noticed when
  // startToCloseTimeout expires — twenty minutes of a sweep sitting still.
  heartbeatTimeout: "1 minute",
  retry: { initialInterval: "10 seconds", maximumAttempts: 3 },
});

/** One repo: seconds of network, then a handful of writes. */
const { syncRepo } = proxyActivities<AtprotoSyncActivities>({
  // One attempt. A repo is two HTTP round trips plus its records; two minutes is
  // generous even for a slow PDS with hundreds of them.
  startToCloseTimeout: "2 minutes",
  // Every attempt, together. Without it a repo on a host that accepts
  // connections and then hangs costs its full retry chain of timeouts, and the
  // window it is in waits for all of it. This is the ceiling on that tail.
  scheduleToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    // A PDS being briefly unreachable is the common case and is worth three
    // tries. Past that it is an outage on their side, and the next scheduled
    // sweep is a better answer than a fourth attempt inside this one.
    maximumAttempts: 3,
  },
});

/** The bookkeeping: single statements against our own Postgres. Fast, or broken. */
const { openSyncRun, reconcileMissingRepos, closeSyncRun } = proxyActivities<AtprotoSyncActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3 },
});

export async function atprotoSync(input: AtprotoSyncInput = {}): Promise<SweepSummary> {
  // What one run should do, forwarded to every activity that needs it. What the
  // *deployment* does — which relay, which PDS — is environment, resolved inside
  // the activities.
  const scope = { dryRun: input.dryRun, maxRepos: input.maxRepos, onlyDid: input.onlyDid };

  // A continuation is the tail of a sweep that outgrew one execution's history.
  // Everything before this point already happened, in a previous execution.
  const start: SweepContinuation = input.continuation ?? (await beginSweep());

  let { cursor, summary } = start;
  const { dids, fullSweep, syncRunId } = start;

  try {
    for (const window of windows(dids.slice(cursor), input.parallelism)) {
      // `allSettled`, not `all`: a repo that has exhausted its retries is a
      // counted failure, not the end of the sweep. `all` would abandon the rest
      // of the window as well, and lose the results of the repos that succeeded.
      const results = await Promise.allSettled(window.map((did) => syncRepo({ ...scope, did })));
      for (const result of results) {
        summary = foldRepo(summary, result.status === "fulfilled" ? result.value : undefined);
      }
      cursor += window.length;
      log.info("window complete", { done: cursor, of: dids.length, ...summary });

      // The server tells us when this execution's history is getting long
      // enough to be worth ending. Handing the rest to a fresh execution is what
      // keeps a per-repo sweep of a large network inside the event limits — the
      // new run starts with an empty history and the same cursor.
      if (workflowInfo().continueAsNewSuggested && cursor < dids.length) {
        log.info("continuing as new", { done: cursor, of: dids.length, historyLength: workflowInfo().historyLength });
        await continueAsNew<typeof atprotoSync>({ ...input, continuation: { dids, cursor, fullSweep, syncRunId, summary } });
      }
    }

    if (fullSweep && !summary.dryRun) {
      summary = { ...summary, reposMarkedMissing: await reconcileMissingRepos({ dids }) };
    }

    await closeSyncRun({ syncRunId, summary, error: null });
    return summary;
  } catch (err) {
    // `continueAsNew` reports itself by throwing, so this catch sees it. Letting
    // it through untouched is mandatory: closing the run row here would end the
    // bookkeeping for a sweep that is still going, and wrapping it would turn a
    // handover into a failure.
    if (err instanceof ContinueAsNew) throw err;

    // Close the run row before the failure propagates, so a sweep that died
    // mid-flight does not leave a row saying `running` forever.
    //
    // `nonCancellable` is load-bearing: if this workflow is being *cancelled*,
    // its cancellation scope is already cancelled, and an activity started inside
    // it would be cancelled before it ran. Cleanup has to opt out of that, or it
    // is not cleanup.
    const failed: SweepSummary = { ...summary, status: "error" };
    await CancellationScope.nonCancellable(() => closeSyncRun({ syncRunId, summary: failed, error: String(err) }));

    // A cancelled sweep is cancelled, not failed. Rethrowing the cancellation
    // unchanged is what lets the execution close as CANCELED; wrapping it would
    // put a red FAILED in the UI for something a person asked for.
    if (isCancellation(err)) throw err;

    // Otherwise rethrown wrapped. `fromError` keeps the original message and
    // cause, so the UI still shows which activity failed and why; what it adds is
    // a type worth filtering on and the partial summary as failure details, which
    // is the only record of how far a dead sweep got.
    throw ApplicationFailure.fromError(err, { type: "AtprotoSyncFailed", details: [failed] });
  }

  /** The first execution's opening moves: find the work, and open the run row. */
  async function beginSweep(): Promise<SweepContinuation> {
    const { dids, fullSweep } = await enumerateRepos(scope);
    log.info("enumerated repos", { count: dids.length, fullSweep });

    const summary = { ...emptySummary(scope.dryRun === true), reposSeen: dids.length };
    const syncRunId = await openSyncRun(scope);

    return { dids, cursor: 0, fullSweep, syncRunId, summary: { ...summary, syncRunId } };
  }
}
