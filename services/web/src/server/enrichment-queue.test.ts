import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No Redis in this environment, so this covers only what `enqueueEnrich` can
// promise without one: it never throws, it no-ops when `REDIS_URL` is unset,
// and it builds the job with the right name/payload/deterministic id when a
// connection is available. The actual BullMQ wire behavior is the pipeline
// side's DB/integration tests to cover, not this module's.

const addMock = vi.fn();
const getJobMock = vi.fn();
const QueueMock = vi.fn(function Queue() {
  // `getJob` is only exercised by `enqueueLlmEnrich`'s tests below —
  // `enqueueEnrich` never calls it, so leaving it wired up here for every
  // test is harmless and keeps one Queue mock shared by both describe blocks
  // (the two functions share one real `Queue` singleton in the module under
  // test — see enrichment-queue.ts's module doc).
  return { add: addMock, getJob: getJobMock };
});

vi.mock("bullmq", () => ({ Queue: QueueMock }));
vi.mock("#/lib/redis", () => ({ getRedis: vi.fn(() => ({})) }));

describe("enqueueEnrich", () => {
  const originalRedisUrl = process.env.REDIS_URL;

  beforeEach(() => {
    vi.resetModules();
    addMock.mockReset();
    getJobMock.mockReset();
    QueueMock.mockClear();
  });

  afterEach(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
  });

  it("no-ops without REDIS_URL — a dev machine with no Redis must still save a recipe", async () => {
    delete process.env.REDIS_URL;
    const { enqueueEnrich } = await import("./enrichment-queue");
    await expect(enqueueEnrich("recipe-1")).resolves.toBeUndefined();
    expect(QueueMock).not.toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("adds the enrich job with a deterministic jobId when REDIS_URL is set", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const { enqueueEnrich } = await import("./enrichment-queue");
    await enqueueEnrich("recipe-1");
    expect(addMock).toHaveBeenCalledWith("enrich", { recipeId: "recipe-1" }, { jobId: "enrich_recipe-1" });
  });

  it("swallows and logs a failed enqueue instead of throwing (D3: latency, not correctness)", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    addMock.mockRejectedValueOnce(new Error("connection refused"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { enqueueEnrich } = await import("./enrichment-queue");
    await expect(enqueueEnrich("recipe-1")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

// `enqueueLlmEnrich` returns a real outcome instead of `void` (its one
// caller is a button that has to report one) — these pin the four shapes it
// can hand back, plus the deterministic-jobId re-run handling that is the
// whole reason it is more than a one-line variant of `enqueueEnrich` above.
describe("enqueueLlmEnrich", () => {
  const originalRedisUrl = process.env.REDIS_URL;

  beforeEach(() => {
    vi.resetModules();
    addMock.mockReset();
    getJobMock.mockReset();
    QueueMock.mockClear();
  });

  afterEach(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
  });

  it("reports disabled without REDIS_URL — no queue is even constructed", async () => {
    delete process.env.REDIS_URL;
    const { enqueueLlmEnrich } = await import("./enrichment-queue");
    await expect(enqueueLlmEnrich("recipe-1")).resolves.toEqual({ status: "disabled" });
    expect(QueueMock).not.toHaveBeenCalled();
  });

  it("enqueues with force:true and the deterministic jobId when nothing is queued yet", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    getJobMock.mockResolvedValue(undefined);
    const { enqueueLlmEnrich } = await import("./enrichment-queue");
    await expect(enqueueLlmEnrich("recipe-1")).resolves.toEqual({ status: "enqueued", jobId: "llm-enrich_recipe-1" });
    expect(addMock).toHaveBeenCalledWith("llm-enrich", { recipeId: "recipe-1", force: true }, { jobId: "llm-enrich_recipe-1" });
  });

  it("joins a still-running job instead of duplicating it", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const removeMock = vi.fn();
    getJobMock.mockResolvedValue({ getState: vi.fn().mockResolvedValue("active"), remove: removeMock });
    const { enqueueLlmEnrich } = await import("./enrichment-queue");
    await expect(enqueueLlmEnrich("recipe-1")).resolves.toEqual({ status: "already-running", jobId: "llm-enrich_recipe-1", state: "active" });
    expect(removeMock).not.toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("removes a finished job occupying the deterministic id before re-adding, so a repeat click actually reruns", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const removeMock = vi.fn();
    getJobMock.mockResolvedValue({ getState: vi.fn().mockResolvedValue("completed"), remove: removeMock });
    const { enqueueLlmEnrich } = await import("./enrichment-queue");
    await expect(enqueueLlmEnrich("recipe-1")).resolves.toEqual({ status: "enqueued", jobId: "llm-enrich_recipe-1" });
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith("llm-enrich", { recipeId: "recipe-1", force: true }, { jobId: "llm-enrich_recipe-1" });
  });

  it("swallows and logs a failed enqueue instead of throwing", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    getJobMock.mockResolvedValue(undefined);
    addMock.mockRejectedValueOnce(new Error("connection refused"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { enqueueLlmEnrich } = await import("./enrichment-queue");
    await expect(enqueueLlmEnrich("recipe-1")).resolves.toEqual({ status: "error", message: "connection refused" });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
