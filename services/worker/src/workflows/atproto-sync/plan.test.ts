import { describe, expect, it } from "vitest";
import { DEFAULT_PARALLELISM, emptySummary, foldRepo, windows } from "#/workflows/atproto-sync/plan.ts";

describe("windows", () => {
  it("cuts the list into fixed-size windows", () => {
    expect(windows(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("returns no windows for no dids", () => {
    expect(windows([], 10)).toEqual([]);
  });

  it("keeps a short list in one window", () => {
    expect(windows(["a", "b"], 100)).toEqual([["a", "b"]]);
  });

  it("falls back to the default for a nonsense size", () => {
    // `{"parallelism":"nope"}` reaches here as NaN; a zero or negative size
    // would loop forever, so both are the same bug and get the same answer.
    expect(
      windows(
        Array.from({ length: 3 * DEFAULT_PARALLELISM }, (_, i) => String(i)),
        Number.NaN,
      ),
    ).toHaveLength(3);
    expect(windows(["a", "b"], 0)).toEqual([["a", "b"]]);
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
