import { defineWorkflow, type Step } from "#/workflows/define.ts";
import { log } from "#/log.ts";

/**
 * A do-nothing workflow that exists to prove the wiring works end to end:
 * enqueue → a worker picks it up → the steps tick past in order → it completes,
 * all visible in the Bull Board UI. It is the fastest way to answer "is the
 * deployed board actually talking to the worker fleet, or just to Redis?".
 *
 * It doubles as the reference implementation of `define.ts`: three steps, a
 * parsed payload, per-step progress, a deliberate failure, and the only
 * `resumeOnRetry: true` in the service. Everything a real workflow does, with
 * `setTimeout` where the work would be.
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

interface DemoState {
  payload: DemoPayload;
  startedAt: string;
}

const MAX_DURATION_MS = 30_000;
const TICKS = 10;

function parse(data: unknown): DemoPayload {
  const raw = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const durationMs = Number(raw.durationMs);
  return {
    durationMs: Number.isFinite(durationMs) ? Math.min(Math.max(durationMs, 0), MAX_DURATION_MS) : 1_000,
    label: typeof raw.label === "string" ? raw.label : "demo",
    fail: raw.fail === true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- steps -----------------------------------------------------------------

/** A short fixed phase, so the board shows the job moving before the long one. */
const warmUp: Step<DemoState> = {
  name: "warm-up",
  run: async ({ state, log: line }) => {
    await sleep(Math.round(state.payload.durationMs * 0.2));
    await line(`ready to work on "${state.payload.label}"`);
  },
};

/** The bulk of the simulated work, reporting progress as it goes. */
const work: Step<DemoState> = {
  name: "work",
  run: async ({ state, progress }) => {
    const tick = Math.round((state.payload.durationMs * 0.8) / TICKS);
    for (let i = 1; i <= TICKS; i++) {
      await sleep(tick);
      await progress(i / TICKS);
    }
  },
};

/**
 * Where a `fail: true` job fails — the LAST step, deliberately. With
 * `resumeOnRetry` on, the retry resumes here and fails again in milliseconds
 * instead of redoing the sleeps, which is the whole point being demonstrated:
 * watch the second attempt's log in the board and there is no "work" step in it.
 */
const finish: Step<DemoState> = {
  name: "finish",
  run: ({ state }) => {
    if (state.payload.fail) {
      throw new Error(`demo job asked to fail (label=${state.payload.label})`);
    }
    log.info("demo job complete", { label: state.payload.label, durationMs: state.payload.durationMs });
    return Promise.resolve();
  },
};

export const demo = defineWorkflow<DemoState>({
  name: "demo",
  description: "No-op job with progress reporting — proves the queue, workers and board are wired together",
  start: (payload) => ({ payload: parse(payload), startedAt: new Date().toISOString() }),
  steps: [warmUp, work, finish],
  result: (state) => ({ label: state.payload.label, startedAt: state.startedAt, finishedAt: new Date().toISOString() }),
  // Sound here, unlike the sweep: every step works from `start()`'s state alone,
  // so skipping the earlier ones costs nothing but the time they would burn.
  resumeOnRetry: true,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
    // Keep enough history to look at in the UI, not enough to grow unbounded.
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 100 },
  },
});
