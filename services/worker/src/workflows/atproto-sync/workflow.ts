import { ApplicationFailure, CancellationScope, log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "#/workflows/atproto-sync/activities.ts";
import { batchDids, emptySummary, foldBatch } from "#/workflows/atproto-sync/plan.ts";
import type { AtprotoSyncInput, SweepSummary } from "#/workflows/atproto-sync/types.ts";

/**
 * Sweep the atproto network and reconcile the Postgres recipe index.
 *
 * This was a Railway cron service. As a Temporal workflow it is the same
 * enumerate → index → reconcile it always was, cut at the seams it already had
 * — but the cut now buys durability rather than just tidiness: each `await`
 * below is a point the run can be resumed from on a different machine. A worker
 * that dies mid-sweep does not restart the sweep; the next worker to pick the
 * run up replays the history, sees which batches already completed, and carries
 * on from the next one.
 *
 * Read this file as the whole algorithm. Everything it calls is an activity, and
 * every activity is a thin wrapper over `lib/` — see `activities.ts`.
 *
 * ## The one thing to watch
 *
 * `dids` is carried in workflow state, which means it is carried in the
 * *history*: `enumerateRepos`' result is written there once and replayed on
 * every resume. At a few thousand DIDs that is ~150 KB against a 2 MB payload
 * limit, which is fine and will stay fine for a long while. It is not fine
 * forever. When it stops being fine, the fix is to page enumeration behind a
 * cursor and have `reconcileMissingRepos` work from the run's start timestamp
 * instead of the list — at which point this workflow never holds more than one
 * batch at a time, and `continueAsNew` handles the rest.
 */

// Two proxies because the two kinds of activity here want opposite settings, and
// a single set of options would have to be wrong for one of them.

/** The work: minutes long, network-bound, worth retrying, and it heartbeats. */
const { enumerateRepos, indexRepoBatch, reconcileMissingRepos } = proxyActivities<typeof activities>({
  startToCloseTimeout: "20 minutes",
  // Without this, a worker that is killed mid-batch is only noticed when
  // startToCloseTimeout expires — twenty minutes of a sweep sitting still.
  // With it, a batch that stops reporting is rescheduled in a minute.
  heartbeatTimeout: "1 minute",
  retry: {
    initialInterval: "10 seconds",
    backoffCoefficient: 2,
    maximumInterval: "2 minutes",
    // A relay or a PDS being briefly unreachable is the common case and is worth
    // three tries. Past that it is an outage, and the next scheduled sweep is a
    // better answer than a fourth attempt inside this one.
    maximumAttempts: 3,
  },
});

/** The bookkeeping: single statements against our own Postgres. Fast, or broken. */
const { openSyncRun, closeSyncRun } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3 },
});

export async function atprotoSync(input: AtprotoSyncInput = {}): Promise<SweepSummary> {
  const dryRun = input.dryRun === true;

  const { dids, fullSweep } = await enumerateRepos({ dryRun });
  log.info("enumerated repos", { count: dids.length, fullSweep });

  let summary: SweepSummary = { ...emptySummary(dryRun), reposSeen: dids.length };
  summary = { ...summary, syncRunId: await openSyncRun({ dryRun }) };

  try {
    const batches = batchDids(dids, input.batchSize);
    for (const [i, batch] of batches.entries()) {
      // Sequential on purpose. The parallelism that matters is inside the
      // activity (`SYNC_CONCURRENCY` DIDs at a time against different PDSes);
      // running batches concurrently as well would multiply the load on our own
      // Postgres pool without making the network go any faster.
      summary = foldBatch(summary, await indexRepoBatch({ dids: batch, dryRun }));
      log.info("batch complete", { batch: i + 1, of: batches.length, ...summary });
    }

    if (fullSweep && !dryRun) {
      summary = { ...summary, reposMarkedMissing: await reconcileMissingRepos({ dids }) };
    }

    await closeSyncRun({ syncRunId: summary.syncRunId, summary, error: null });
    return summary;
  } catch (err) {
    // Close the run row before the failure propagates, so a sweep that died
    // mid-flight does not leave a row saying `running` forever.
    //
    // `nonCancellable` is load-bearing: if this workflow is being *cancelled*,
    // its cancellation scope is already cancelled, and an activity started
    // inside it would be cancelled before it ran. Cleanup has to opt out of
    // that, or it is not cleanup.
    const failed: SweepSummary = { ...summary, status: "error" };
    await CancellationScope.nonCancellable(() => closeSyncRun({ syncRunId: failed.syncRunId, summary: failed, error: String(err) }));

    // Rethrown, always. `fromError` keeps the original message and cause, so the
    // UI still shows which activity failed and why; what it adds is a type worth
    // filtering on and the partial summary as failure details, which is the only
    // record of how far a dead sweep got.
    throw ApplicationFailure.fromError(err, { type: "AtprotoSyncFailed", details: [failed] });
  }
}
