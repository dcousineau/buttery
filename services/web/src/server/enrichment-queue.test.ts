import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No Redis in this environment, so this covers only what `enqueueEnrich` can
// promise without one: it never throws, it no-ops when `REDIS_URL` is unset,
// and it builds the job with the right name/payload/deterministic id when a
// connection is available. The actual BullMQ wire behavior is the pipeline
// side's DB/integration tests to cover, not this module's.

const addMock = vi.fn();
const QueueMock = vi.fn(function Queue() {
  return { add: addMock };
});

vi.mock("bullmq", () => ({ Queue: QueueMock }));
vi.mock("#/lib/redis", () => ({ getRedis: vi.fn(() => ({})) }));

describe("enqueueEnrich", () => {
  const originalRedisUrl = process.env.REDIS_URL;

  beforeEach(() => {
    vi.resetModules();
    addMock.mockReset();
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
