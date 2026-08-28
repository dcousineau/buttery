import type { Redis } from "ioredis";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StepContext } from "#/lib/bullmq/kernel.ts";

/**
 * `sync-repo`'s enrichment fan-out (recipe-enrichment plan §9): it enqueues
 * `recipe-enrichment`/`enrich` once per id `sweepDid` reports as advanced, never
 * on a dry run, and a failed enqueue must cost the repo neither its return value
 * nor its remaining ids (D3 — best-effort). `sweepDid` itself, and the config/db
 * plumbing around it, are mocked: this suite is about the enqueue wiring, not
 * the sweep mechanics `sweep.ts`'s own tests and the db suites already cover.
 */

// Typed, not bare `vi.fn()`: an untyped mock returns `any`, and the thin arrows
// below would then be unsafe returns into a module the rest of the file trusts.
const sweepDidMock = vi.fn<(...args: unknown[]) => unknown>();
const loadSyncConfigMock = vi.fn<(...args: unknown[]) => unknown>();

vi.mock("#/workflows/atproto-sync/lib/sweep.ts", () => ({
  sweepDid: (...args: unknown[]) => sweepDidMock(...args),
  markRepoError: vi.fn(),
  closeSyncRun: vi.fn(),
  markMissingRepos: vi.fn(),
  openSyncRun: vi.fn(),
  registerRepos: vi.fn(),
}));

vi.mock("#/workflows/atproto-sync/lib/config.ts", () => ({
  loadSyncConfig: (...args: unknown[]) => loadSyncConfigMock(...args),
  RECIPE_COLLECTION: "exchange.recipe.recipe",
}));

vi.mock("#/workflows/atproto-sync/lib/db.ts", () => ({
  getPool: vi.fn(() => ({})),
}));

const { steps } = await import("#/workflows/atproto-sync/steps.ts");
const syncRepo = steps.find((s) => s.name === "sync-repo");
if (!syncRepo) throw new Error("sync-repo step not found");

const NO_REDIS = {} as Redis;

function context(payload: unknown, enqueue: StepContext["enqueue"]): StepContext {
  return {
    payload,
    runId: "test",
    log: vi.fn().mockResolvedValue(undefined),
    progress: vi.fn().mockResolvedValue(undefined),
    children: vi.fn().mockResolvedValue({ values: [], failures: [] }),
    flow: vi.fn().mockResolvedValue(undefined),
    enqueue,
    redis: NO_REDIS,
  };
}

describe("sync-repo enrichment fan-out", () => {
  beforeEach(() => {
    sweepDidMock.mockReset();
    loadSyncConfigMock.mockReset();
  });

  it("enqueues recipe-enrichment once per advanced recipe id", async () => {
    loadSyncConfigMock.mockReturnValue({ databaseUrl: "postgres://x", dryRun: false });
    sweepDidMock.mockResolvedValue({
      outcome: { did: "did:plc:a", upserted: 2, deleted: 0 },
      advancedRecipeIds: ["recipe-1", "recipe-2"],
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);

    const result = await syncRepo.run(context({ did: "did:plc:a" }, enqueue));

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenNthCalledWith(1, "recipe-enrichment", { step: "enrich", data: { recipeId: "recipe-1" } });
    expect(enqueue).toHaveBeenNthCalledWith(2, "recipe-enrichment", { step: "enrich", data: { recipeId: "recipe-2" } });
    expect(result).toEqual({ did: "did:plc:a", upserted: 2, deleted: 0 });
  });

  it("does not enqueue anything when no recipe advanced", async () => {
    loadSyncConfigMock.mockReturnValue({ databaseUrl: "postgres://x", dryRun: false });
    sweepDidMock.mockResolvedValue({ outcome: { did: "did:plc:a", upserted: 0, deleted: 0 }, advancedRecipeIds: [] });
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await syncRepo.run(context({ did: "did:plc:a" }, enqueue));

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not enqueue on a dry run", async () => {
    loadSyncConfigMock.mockReturnValue({ databaseUrl: "postgres://x", dryRun: true });
    // A dry run never calls renderRecipe (sweep.ts), so sweepDid itself would
    // never report an advanced id — asserted here anyway as the belt-and-
    // suspenders the sync-repo comment promises: even if it did, dryRun stops
    // the enqueue loop before it runs.
    sweepDidMock.mockResolvedValue({ outcome: { did: "did:plc:a", upserted: 1, deleted: 0 }, advancedRecipeIds: ["recipe-1"] });
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await syncRepo.run(context({ did: "did:plc:a", dryRun: true }, enqueue));

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not fail the repo sweep, or skip remaining ids, when an enqueue rejects", async () => {
    loadSyncConfigMock.mockReturnValue({ databaseUrl: "postgres://x", dryRun: false });
    sweepDidMock.mockResolvedValue({
      outcome: { did: "did:plc:a", upserted: 2, deleted: 0 },
      advancedRecipeIds: ["recipe-1", "recipe-2"],
    });
    // The first id's enqueue fails (a typo-class error, or a transient one —
    // either way ctx.enqueue rejects); the second must still be attempted, and
    // the step must still resolve with the repo's outcome rather than throwing.
    const enqueue = vi.fn().mockRejectedValueOnce(new Error('ctx.enqueue: no workflow named "recipe-enrichment"')).mockResolvedValueOnce(undefined);

    const value = await syncRepo.run(context({ did: "did:plc:a" }, enqueue));

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(value).toEqual({ did: "did:plc:a", upserted: 2, deleted: 0 });
  });
});
