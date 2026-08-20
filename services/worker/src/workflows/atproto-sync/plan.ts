import type { RepoOutcome, SweepSummary } from "#/workflows/atproto-sync/types.ts";

/**
 * The parts of the sweep that are arithmetic rather than work.
 *
 * They live beside `workflow.ts` instead of in `lib/` because of where they run:
 * this file is bundled into the workflow sandbox, so it may not touch I/O, the
 * clock, or randomness. Pure functions only — which is also why they are the
 * easiest thing in the service to test.
 */

/** `syncRepo` activities in flight at once when the input does not say. */
export const DEFAULT_PARALLELISM = 8;

/**
 * Cut the remaining DIDs into windows of `size`, which the workflow starts as
 * one `Promise.all` each.
 *
 * A window rather than a rolling pool: the workflow waits for all of a window
 * before starting the next, so one slow repo can leave a few slots idle. That
 * costs a little throughput and buys code with no shared mutable cursor in it,
 * which is worth more inside a function that gets replayed.
 */
export function windows(dids: readonly string[], size = DEFAULT_PARALLELISM): string[][] {
  const bounded = Number.isFinite(size) && size > 0 ? Math.floor(size) : DEFAULT_PARALLELISM;
  const chunks: string[][] = [];
  for (let i = 0; i < dids.length; i += bounded) {
    chunks.push(dids.slice(i, i + bounded));
  }
  return chunks;
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
 * Fold one repo's result into the running summary — its counts if it was swept,
 * a failure if it was not. Returns a new object rather than mutating: the
 * workflow keeps the summary across `await`s that may be replayed, and a value
 * that is only ever replaced is one less thing that can be half-updated.
 */
export function foldRepo(summary: SweepSummary, outcome: RepoOutcome | undefined): SweepSummary {
  if (!outcome) {
    return { ...summary, reposFailed: summary.reposFailed + 1 };
  }
  return {
    ...summary,
    recordsUpserted: summary.recordsUpserted + outcome.upserted,
    recordsDeleted: summary.recordsDeleted + outcome.deleted,
  };
}
