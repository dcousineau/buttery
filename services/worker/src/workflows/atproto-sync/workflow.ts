import { ApplicationFailure, CancellationScope, ContinueAsNew, continueAsNew, isCancellation, log, proxyActivities, workflowInfo } from "@temporalio/workflow";
import type { AtprotoSyncActivities } from "#/workflows/atproto-sync/activities.ts";
import { boundedParallelism, emptySummary, foldRepo } from "#/workflows/atproto-sync/plan.ts";
import type { AtprotoSyncInput, RepoOutcome, SweepContinuation, SweepSummary } from "#/workflows/atproto-sync/types.ts";

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
 * They run as a rolling pool of `parallelism` runners rather than in lockstep
 * batches: a runner that finishes a repo takes the next one immediately, so a
 * single slow PDS costs its own slot and nobody else's. Nothing waits for a
 * batch boundary, because there are no batches.
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

/**
 * One repo: a couple of HTTP round trips, then a handful of writes.
 *
 * The timeouts are sized from a measured sweep of the live network — a healthy
 * repo takes ~700 ms (p50) and ~1 s (p90) — so they are generous by an order of
 * magnitude while still being short enough that an unresponsive host is dropped
 * quickly rather than held onto.
 */
const { syncRepo } = proxyActivities<AtprotoSyncActivities>({
  // One attempt. Forty-five times the p90, which leaves room for a repo with
  // hundreds of records paging slowly, and still gives up on a hung host in a
  // fraction of the time the old two minutes did.
  startToCloseTimeout: "45 seconds",
  // Every attempt together — the hang budget for one repo. A host that accepts
  // connections and never answers costs at most this before the sweep moves on,
  // instead of however long three attempts and their backoff happen to take.
  scheduleToCloseTimeout: "90 seconds",
  retry: {
    // Short, because a repo is short. Waiting a minute between attempts on a
    // one-second unit of work only makes the tail longer.
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "10 seconds",
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

/** Repos between progress lines. Every repo would be thousands of lines at network scale. */
const PROGRESS_EVERY = 25;

export async function atprotoSync(input: AtprotoSyncInput = {}): Promise<SweepSummary> {
  // What one run should do, forwarded to every activity that needs it. What the
  // *deployment* does — which relay, which PDS — is environment, resolved inside
  // the activities.
  const scope = { dryRun: input.dryRun, maxRepos: input.maxRepos, onlyDid: input.onlyDid };

  // A continuation is the tail of a sweep that outgrew one execution's history.
  // Everything before this point already happened, in a previous execution.
  const start: SweepContinuation = input.continuation ?? (await beginSweep());

  const { dids, fullSweep, syncRunId } = start;
  let summary = start.summary;
  /** The next DID no runner has claimed. Everything below it is done. */
  let next = start.cursor;
  /** Set once the server suggests this execution's history is long enough. */
  let handover = false;
  let swept = 0;

  try {
    // A rolling pool: `parallelism` runners, each taking the next unclaimed DID
    // the moment it finishes the last one. `next` is shared between them, which
    // is safe — a workflow runs on one thread, and `next++` happens between
    // awaits — and deterministic on replay, because activity results are
    // redelivered in the order the history recorded them.
    const runners = Array.from({ length: Math.min(boundedParallelism(input.parallelism), dids.length - next) }, async () => {
      while (next < dids.length && !handover) {
        const did = dids[next++];

        // Await FIRST, fold second. `foldRepo(summary, await …)` would read
        // `summary` before suspending, so two runners suspending on their own
        // repos would both fold onto the same stale value and one result would
        // vanish — silently, as a count that is merely too low. Every read of
        // shared state in this loop has to happen after the await that precedes
        // it, not in the same expression.
        const outcome = await sweepOne(did);
        summary = foldRepo(summary, outcome);

        swept++;
        if (swept % PROGRESS_EVERY === 0) log.info("sweep progress", { done: next, of: dids.length, ...summary });

        // Checked here rather than on a timer: the server raises this once the
        // history is long enough to be worth ending, and the cheapest place to
        // notice is between two repos.
        if (workflowInfo().continueAsNewSuggested) handover = true;
      }
    });
    await Promise.all(runners);

    // Every DID below `next` is finished, not merely started: the runners stop
    // *claiming* work when `handover` is set, and the `Promise.all` above waits
    // for the ones already in flight. That is what keeps the cursor a clean
    // prefix even though repos complete out of order.
    if (handover && next < dids.length) {
      log.info("continuing as new", { done: next, of: dids.length, historyLength: workflowInfo().historyLength });
      await continueAsNew<typeof atprotoSync>({ ...input, continuation: { dids, cursor: next, fullSweep, syncRunId, summary } });
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

  /**
   * One repo, with its failure absorbed. A repo that exhausts its retries is
   * counted and stepped over; a *cancellation* is not a repo failure and has to
   * keep unwinding, or a cancelled sweep would quietly grind through the rest of
   * the network marking everything failed.
   */
  async function sweepOne(did: string): Promise<RepoOutcome | undefined> {
    try {
      return await syncRepo({ ...scope, did });
    } catch (err) {
      if (isCancellation(err)) throw err;
      log.warn("repo failed after retries", { did, err: String(err) });
      return undefined;
    }
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
