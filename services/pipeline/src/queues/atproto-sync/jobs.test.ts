import type { FastifyInstance } from "fastify";
import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `sync-repo`'s downstream side effects (recipe-enrichment plan §9 and the
 * inlined household autoimport): it enqueues `recipe-enrichment`/`enrich` once
 * per id `sweepDid` reports as advanced, runs autoimport inline once per id,
 * never on a dry run, and a failure in either side effect must cost the repo
 * neither its return value nor its remaining ids (D3 — best-effort). `sweepDid`
 * itself, and the config/db plumbing around it, are mocked: this suite is about
 * the wiring, not the sweep mechanics `sweep.ts`'s own tests and the db suites
 * already cover.
 *
 * `jobs.ts` exports its handlers as plain functions of `(fastify, job)` rather
 * than a factory that closes over one — no module mock for a pool that no
 * longer exists, and no factory call here either. `fastify` is a stub carrying
 * `db`, `log` and `bullmq.get` (the new home of what used to be `ctx.enqueue`);
 * `job` is a stub carrying only what `sync-repo` actually touches (`data` and
 * `log`).
 */

// Typed, not bare `vi.fn()`: an untyped mock returns `any`, and the thin arrows
// below would then be unsafe returns into a module the rest of the file trusts.
const sweepDidMock = vi.fn<(...args: unknown[]) => unknown>();
const loadSyncConfigMock = vi.fn<(...args: unknown[]) => unknown>();
const autoimportRecipeMock = vi.fn<(...args: unknown[]) => unknown>();

vi.mock("#/queues/atproto-sync/lib/sweep.ts", () => ({
  sweepDid: (...args: unknown[]) => sweepDidMock(...args),
  markRepoError: vi.fn(),
  closeSyncRun: vi.fn(),
  markMissingRepos: vi.fn(),
  openSyncRun: vi.fn(),
  registerRepos: vi.fn(),
}));

vi.mock("#/queues/atproto-sync/lib/config.ts", () => ({
  loadSyncConfig: (...args: unknown[]) => loadSyncConfigMock(...args),
  RECIPE_COLLECTION: "exchange.recipe.recipe",
}));

vi.mock("#/queues/atproto-sync/lib/autoimport.ts", () => ({
  autoimportRecipeForMemberHouseholds: (...args: unknown[]) => autoimportRecipeMock(...args),
}));

const { syncRepo } = await import("#/queues/atproto-sync/jobs.ts");

/** A stub registration shaped like `plugins/bullmq.ts`'s `QueueRegistration` — only the `queue.add` `sync-repo` actually calls. */
function fakeRegistration(add: (...args: unknown[]) => unknown): { queue: { add: (...args: unknown[]) => unknown } } {
  return { queue: { add } };
}

function fakeFastify(enqueue: (...args: unknown[]) => unknown): FastifyInstance {
  return {
    db: {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    redis: {},
    bullmq: { get: vi.fn().mockReturnValue(fakeRegistration(enqueue)) },
  } as unknown as FastifyInstance;
}

/** A stub `Job` carrying only what `sync-repo` reads: `data` and `log`. */
function fakeJob(data: unknown): Job {
  return { data, log: vi.fn().mockResolvedValue(undefined) } as unknown as Job;
}

describe("sync-repo downstream side effects", () => {
  beforeEach(() => {
    sweepDidMock.mockReset();
    loadSyncConfigMock.mockReset();
    autoimportRecipeMock.mockReset();
  });

  it("enqueues recipe-enrichment and runs autoimport once per advanced recipe id", async () => {
    loadSyncConfigMock.mockReturnValue({ databaseUrl: "postgres://x", dryRun: false });
    sweepDidMock.mockResolvedValue({
      outcome: { did: "did:plc:a", upserted: 2, deleted: 0 },
      advancedRecipeIds: ["recipe-1", "recipe-2"],
    });
    autoimportRecipeMock.mockResolvedValue(0);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const fastify = fakeFastify(enqueue);

    const result = await syncRepo(fastify, fakeJob({ did: "did:plc:a" }));

    expect(fastify.bullmq.get).toHaveBeenCalledWith("recipe-enrichment");
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenNthCalledWith(1, "enrich", { recipeId: "recipe-1" });
    expect(enqueue).toHaveBeenNthCalledWith(2, "enrich", { recipeId: "recipe-2" });
    expect(autoimportRecipeMock).toHaveBeenCalledTimes(2);
    expect(autoimportRecipeMock).toHaveBeenNthCalledWith(1, fastify.db, "recipe-1");
    expect(autoimportRecipeMock).toHaveBeenNthCalledWith(2, fastify.db, "recipe-2");
    expect(result).toEqual({ did: "did:plc:a", upserted: 2, deleted: 0 });
  });

  it("does not run side effects when no recipe advanced", async () => {
    loadSyncConfigMock.mockReturnValue({ databaseUrl: "postgres://x", dryRun: false });
    sweepDidMock.mockResolvedValue({ outcome: { did: "did:plc:a", upserted: 0, deleted: 0 }, advancedRecipeIds: [] });
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await syncRepo(fakeFastify(enqueue), fakeJob({ did: "did:plc:a" }));

    expect(enqueue).not.toHaveBeenCalled();
    expect(autoimportRecipeMock).not.toHaveBeenCalled();
  });

  it("does not run side effects on a dry run", async () => {
    loadSyncConfigMock.mockReturnValue({ databaseUrl: "postgres://x", dryRun: true });
    // A dry run never calls renderRecipe (sweep.ts), so sweepDid itself would
    // never report an advanced id — asserted here anyway as the belt-and-
    // suspenders the sync-repo comment promises: even if it did, dryRun stops
    // the loop before it runs.
    sweepDidMock.mockResolvedValue({ outcome: { did: "did:plc:a", upserted: 1, deleted: 0 }, advancedRecipeIds: ["recipe-1"] });
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await syncRepo(fakeFastify(enqueue), fakeJob({ did: "did:plc:a", dryRun: true }));

    expect(enqueue).not.toHaveBeenCalled();
    expect(autoimportRecipeMock).not.toHaveBeenCalled();
  });

  it("does not fail the repo sweep, or skip remaining ids, when enrichment enqueue rejects", async () => {
    loadSyncConfigMock.mockReturnValue({ databaseUrl: "postgres://x", dryRun: false });
    sweepDidMock.mockResolvedValue({
      outcome: { did: "did:plc:a", upserted: 2, deleted: 0 },
      advancedRecipeIds: ["recipe-1", "recipe-2"],
    });
    // The first id's enqueue fails (a bad queue registration, or a transient
    // Redis hiccup); the remaining side effects must still be attempted, and the
    // job must still resolve with the repo's outcome rather than throwing.
    const enqueue = vi.fn().mockRejectedValueOnce(new Error("redis unavailable")).mockResolvedValue(undefined);
    autoimportRecipeMock.mockResolvedValue(0);

    const value = await syncRepo(fakeFastify(enqueue), fakeJob({ did: "did:plc:a" }));

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(autoimportRecipeMock).toHaveBeenCalledTimes(2);
    expect(value).toEqual({ did: "did:plc:a", upserted: 2, deleted: 0 });
  });

  it("does not fail the repo sweep, or skip remaining ids, when autoimport rejects", async () => {
    loadSyncConfigMock.mockReturnValue({ databaseUrl: "postgres://x", dryRun: false });
    sweepDidMock.mockResolvedValue({
      outcome: { did: "did:plc:a", upserted: 2, deleted: 0 },
      advancedRecipeIds: ["recipe-1", "recipe-2"],
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    autoimportRecipeMock.mockRejectedValueOnce(new Error("db unavailable")).mockResolvedValue(0);

    const value = await syncRepo(fakeFastify(enqueue), fakeJob({ did: "did:plc:a" }));

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(autoimportRecipeMock).toHaveBeenCalledTimes(2);
    expect(value).toEqual({ did: "did:plc:a", upserted: 2, deleted: 0 });
  });

  it("does not fail the repo sweep when the enrichment queue isn't registered", async () => {
    // `fastify.bullmq.get` returns `undefined` for an unregistered queue name —
    // this is the case the jobs.ts comment calls out: a bare `get(...)?.queue.add`
    // would silently drop the enqueue with nothing logged, so `syncRepo` looks
    // the registration up itself and throws when it's missing, which lands here
    // in the same per-id catch as a rejected `add`.
    loadSyncConfigMock.mockReturnValue({ databaseUrl: "postgres://x", dryRun: false });
    sweepDidMock.mockResolvedValue({
      outcome: { did: "did:plc:a", upserted: 1, deleted: 0 },
      advancedRecipeIds: ["recipe-1"],
    });
    autoimportRecipeMock.mockResolvedValue(0);
    const fastify = {
      db: {},
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      redis: {},
      bullmq: { get: vi.fn().mockReturnValue(undefined) },
    } as unknown as FastifyInstance;

    const value = await syncRepo(fastify, fakeJob({ did: "did:plc:a" }));

    expect(fastify.log.error).toHaveBeenCalledWith(expect.objectContaining({ did: "did:plc:a", recipeId: "recipe-1" }), "failed to enqueue recipe enrichment");
    expect(autoimportRecipeMock).toHaveBeenCalledWith(fastify.db, "recipe-1");
    expect(value).toEqual({ did: "did:plc:a", upserted: 1, deleted: 0 });
  });
});
