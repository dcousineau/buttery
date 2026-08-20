import type { BatchOutcome, SweepSummary } from "#/workflows/atproto-sync/types.ts";

/**
 * The parts of the sweep that are arithmetic rather than work.
 *
 * They live beside `workflow.ts` instead of in `lib/` because of where they run:
 * this file is bundled into the workflow sandbox, so it may not touch I/O, the
 * clock, or randomness. Pure functions only — which is also why they are the
 * easiest thing in the service to test.
 */

/** DIDs per `indexRepoBatch` activity when the input does not say. */
export const DEFAULT_BATCH_SIZE = 100;

/**
 * Cut the DID list into batches.
 *
 * Batching is the one structural decision this workflow makes. Sweeping every
 * repo in a single activity would put a multi-thousand-repo retry behind one
 * failure; one activity per repo would put thousands of events in the history
 * (Temporal warns past 10k and hard-caps at 50k) to save work that a batch does
 * in seconds. A batch is the middle: the unit of retry, and the unit of progress
 * the UI shows.
 */
export function batchDids(dids: readonly string[], size = DEFAULT_BATCH_SIZE): string[][] {
  const bounded = Number.isFinite(size) && size > 0 ? Math.floor(size) : DEFAULT_BATCH_SIZE;
  const batches: string[][] = [];
  for (let i = 0; i < dids.length; i += bounded) {
    batches.push(dids.slice(i, i + bounded));
  }
  return batches;
}

/** A summary with nothing in it yet. */
export function emptySummary(dryRun: boolean): SweepSummary {
  return {
    syncRunId: null,
    status: "ok",
    reposSeen: 0,
    recordsUpserted: 0,
    recordsDeleted: 0,
    reposFailed: 0,
    reposMarkedMissing: 0,
    dryRun,
  };
}

/**
 * Fold one batch's counters into the running summary. Returns a new object
 * rather than mutating: the workflow keeps the summary across `await`s that may
 * be replayed, and a value that is only ever replaced is one less thing that can
 * be half-updated when a replay resumes mid-fold.
 */
export function foldBatch(summary: SweepSummary, outcome: BatchOutcome): SweepSummary {
  return {
    ...summary,
    recordsUpserted: summary.recordsUpserted + outcome.recordsUpserted,
    recordsDeleted: summary.recordsDeleted + outcome.recordsDeleted,
    reposFailed: summary.reposFailed + outcome.reposFailed,
  };
}
