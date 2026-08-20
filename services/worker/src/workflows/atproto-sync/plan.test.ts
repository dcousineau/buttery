import { describe, expect, it } from "vitest";
import { boundedParallelism, DEFAULT_PARALLELISM, emptySummary, foldRepo } from "#/workflows/atproto-sync/plan.ts";

describe("boundedParallelism", () => {
  it("takes the requested number of runners", () => {
    expect(boundedParallelism(3)).toBe(3);
  });

  it("defaults when the input does not ask", () => {
    expect(boundedParallelism(undefined)).toBe(DEFAULT_PARALLELISM);
  });

  it("refuses a nonsense request", () => {
    // `{"parallelism":"nope"}` arrives as NaN, and zero or negative would mean a
    // pool with no runners in it — a sweep that starts and then does nothing at
    // all, which is the worst way for this to fail.
    expect(boundedParallelism(Number.NaN)).toBe(DEFAULT_PARALLELISM);
    expect(boundedParallelism(0)).toBe(DEFAULT_PARALLELISM);
    expect(boundedParallelism(-4)).toBe(DEFAULT_PARALLELISM);
  });

  it("floors a fractional request", () => {
    expect(boundedParallelism(2.9)).toBe(2);
  });
});

describe("foldRepo", () => {
  it("accumulates a swept repo's counters without mutating the summary", () => {
    const before = { ...emptySummary(false), reposSeen: 3 };
    const after = foldRepo(before, { upserted: 4, deleted: 1 });

    expect(after).toMatchObject({ recordsUpserted: 4, recordsDeleted: 1, reposFailed: 0, reposSeen: 3 });
    expect(before.recordsUpserted).toBe(0);
  });

  it("counts a repo with no outcome as failed", () => {
    // A repo that exhausted its retries: the workflow folds `undefined` for it
    // rather than letting one dead PDS end the sweep.
    expect(foldRepo(emptySummary(false), undefined)).toMatchObject({ reposFailed: 1, recordsUpserted: 0 });
  });

  it("adds across repos", () => {
    const folded = [{ upserted: 2, deleted: 0 }, undefined, { upserted: 3, deleted: 5 }].reduce(foldRepo, emptySummary(true));
    expect(folded).toMatchObject({ recordsUpserted: 5, recordsDeleted: 5, reposFailed: 1, dryRun: true, status: "ok" });
  });
});
