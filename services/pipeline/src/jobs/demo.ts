import type { Job } from "bullmq";
import type { PipelineDefinition } from "#/jobs/index.ts";
import { log } from "#/log.ts";

/**
 * A do-nothing pipeline that exists to prove the wiring works end to end:
 * enqueue → a worker picks it up → progress ticks → it completes, all visible in
 * the Bull Board UI. It is the fastest way to answer "is the deployed board
 * actually talking to the worker fleet, or just to Redis?".
 *
 * It stays registered in production on purpose. The queue is empty unless
 * someone posts to it, and `POST /jobs/demo` sits behind the same basic auth as
 * the board, so the cost is one idle queue key in Redis.
 */

interface DemoPayload {
  /** Milliseconds of simulated work. Clamped — this is a smoke test, not a soak test. */
  durationMs: number;
  /** Free-form text echoed back as the job's return value. */
  label: string;
  /** Fail on purpose, to exercise retries and the board's failed tab. */
  fail: boolean;
}

const MAX_DURATION_MS = 30_000;

function parse(data: unknown): DemoPayload {
  const raw = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const durationMs = Number(raw.durationMs);
  return {
    durationMs: Number.isFinite(durationMs) ? Math.min(Math.max(durationMs, 0), MAX_DURATION_MS) : 1_000,
    label: typeof raw.label === "string" ? raw.label : "demo",
    fail: raw.fail === true,
  };
}

const STEPS = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function process(job: Job): Promise<unknown> {
  const payload = parse(job.data);
  const step = Math.round(payload.durationMs / STEPS);

  for (let i = 1; i <= STEPS; i++) {
    await sleep(step);
    await job.updateProgress((i / STEPS) * 100);
  }

  if (payload.fail) {
    throw new Error(`demo job asked to fail (label=${payload.label})`);
  }

  log.info("demo job complete", { jobId: job.id, label: payload.label, durationMs: payload.durationMs });
  return { label: payload.label, finishedAt: new Date().toISOString() };
}

export const demoPipeline: PipelineDefinition = {
  name: "demo",
  description: "No-op job with progress reporting — proves the queue, workers and board are wired together",
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
    // Keep enough history to look at in the UI, not enough to grow unbounded.
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 100 },
  },
  process,
};
