import type { RepoOutcome, SweepSummary } from "#/workflows/atproto-sync/types.ts";

/**
 * The parts of the sweep that are arithmetic rather than work: folding what the
 * repo jobs returned into one summary. No I/O, no environment — which is also
 * why they are the easiest thing in the workflow to test.
 */

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
 * a failure if it was not. Returns a new object rather than mutating: the tail
 * of a sweep is assembled from what the queue hands back, and a value that is
 * only ever replaced is one less thing that can be half-updated.
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

/**
 * Fold everything the repo jobs returned. `values` are the ones that completed;
 * `failed` is how many exhausted their attempts and were stepped over.
 */
export function foldRepos(summary: SweepSummary, values: readonly RepoOutcome[], failed: number): SweepSummary {
  let folded = summary;
  for (const value of values) folded = foldRepo(folded, value);
  for (let i = 0; i < failed; i++) folded = foldRepo(folded, undefined);
  return folded;
}
