import { describe, expect, it } from "vitest";
import { emptySummary, foldRepo, foldRepos } from "#/workflows/atproto-sync/plan.ts";

describe("foldRepo", () => {
  it("adds a repo's counts to the summary", () => {
    const folded = foldRepo(emptySummary(false), { did: "did:plc:a", upserted: 3, deleted: 1 });

    expect(folded.recordsUpserted).toBe(3);
    expect(folded.recordsDeleted).toBe(1);
    expect(folded.reposFailed).toBe(0);
  });

  it("counts a repo with no outcome as failed", () => {
    const folded = foldRepo(emptySummary(false), undefined);

    expect(folded.reposFailed).toBe(1);
    expect(folded.recordsUpserted).toBe(0);
  });

  it("does not mutate what it was given", () => {
    const before = emptySummary(false);
    foldRepo(before, { did: "did:plc:a", upserted: 3, deleted: 1 });

    expect(before.recordsUpserted).toBe(0);
  });
});

describe("foldRepos", () => {
  it("folds the whole fan-out: what came back, and how many did not", () => {
    const summary = foldRepos(
      { ...emptySummary(false), syncRunId: "7", reposSeen: 4 },
      [
        { did: "did:plc:a", upserted: 2, deleted: 0 },
        { did: "did:plc:b", upserted: 5, deleted: 3 },
      ],
      2,
    );

    expect(summary).toEqual({
      syncRunId: "7",
      status: "ok",
      reposSeen: 4,
      recordsUpserted: 7,
      recordsDeleted: 3,
      // Failures are counted, not fatal — an hourly sweep that failed whenever
      // one of thousands of servers was unreachable would always be failing.
      reposFailed: 2,
      reposMarkedMissing: 0,
      dryRun: false,
    });
  });
});
