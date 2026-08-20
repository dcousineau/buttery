import { describe, expect, it } from "vitest";
import { batchDids, DEFAULT_BATCH_SIZE, emptySummary, foldBatch } from "#/workflows/atproto-sync/plan.ts";

describe("batchDids", () => {
  it("cuts the list into fixed-size batches", () => {
    expect(batchDids(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("returns no batches for no dids", () => {
    expect(batchDids([], 10)).toEqual([]);
  });

  it("keeps a short list in one batch", () => {
    expect(batchDids(["a", "b"], 100)).toEqual([["a", "b"]]);
  });

  it("falls back to the default for a nonsense size", () => {
    // `--batch-size=nope` reaches here as NaN; a zero or negative size would
    // loop forever, so both are the same bug and get the same answer.
    expect(
      batchDids(
        Array.from({ length: 150 }, (_, i) => String(i)),
        Number.NaN,
      ),
    ).toHaveLength(2);
    expect(batchDids(["a", "b"], 0)).toEqual([["a", "b"]]);
    expect(DEFAULT_BATCH_SIZE).toBeGreaterThan(0);
  });
});

describe("foldBatch", () => {
  it("accumulates counters without mutating the summary it was given", () => {
    const before = { ...emptySummary(false), reposSeen: 3 };
    const after = foldBatch(before, { recordsUpserted: 4, recordsDeleted: 1, reposFailed: 2 });

    expect(after).toMatchObject({ recordsUpserted: 4, recordsDeleted: 1, reposFailed: 2, reposSeen: 3 });
    expect(before.recordsUpserted).toBe(0);
  });

  it("adds across batches", () => {
    const folded = [
      { recordsUpserted: 2, recordsDeleted: 0, reposFailed: 1 },
      { recordsUpserted: 3, recordsDeleted: 5, reposFailed: 0 },
    ].reduce(foldBatch, emptySummary(true));

    expect(folded).toMatchObject({ recordsUpserted: 5, recordsDeleted: 5, reposFailed: 1, dryRun: true, status: "ok" });
  });
});
