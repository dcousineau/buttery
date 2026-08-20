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
 * How many repos the workflow keeps in flight.
 *
 * This is the *scheduling* limit, and it is the workflow's to choose because
 * Temporal has no per-workflow one: `maxConcurrentActivityTaskExecutions` bounds
 * what a single worker will run at once across everything it is doing, which is
 * the right knob for protecting a machine and the wrong one for saying "don't
 * point fifty requests at the atmosphere from this sweep".
 *
 * Scheduling everything at once is the thing to avoid. It would work — Temporal
 * would queue the tasks and the fleet would drain them — but a full-network
 * sweep would write thousands of ActivityTaskScheduled events into the history
 * in a single workflow task before any of them ran.
 */
export function boundedParallelism(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return DEFAULT_PARALLELISM;
  return Math.floor(requested);
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
