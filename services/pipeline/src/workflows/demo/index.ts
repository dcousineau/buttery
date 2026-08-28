import type { StepSpec } from "#/lib/bullmq/kernel.ts";
import { defineWorkflow } from "#/lib/bullmq/kernel.ts";
import { log } from "#/log.ts";

/**
 * A do-nothing workflow that exists to prove the wiring works end to end:
 * enqueue → a worker picks it up → it fans out → the children run → the report
 * folds them, all visible in the Bull Board UI. It is the fastest way to answer
 * "is the deployed board actually talking to the worker fleet, or just to
 * Redis?", and it answers it in a shape a real workflow uses:
 *
 *     start ──fans out──▶ task × N ──▶ report
 *
 * It stays registered in production on purpose. The queue is empty unless
 * someone posts to it, and `POST /jobs/demo` sits behind the same basic auth as
 * the board, so the cost is one idle queue key in Redis.
 */

interface DemoPayload {
  /** Children to fan out. Clamped — this is a smoke test, not a load test. */
  tasks: number;
  /** Milliseconds of simulated work per child. */
  durationMs: number;
  /** Free-form text echoed back through the graph. */
  label: string;
  /** Fail every child on purpose, to exercise retries and the board's failed tab. */
  fail: boolean;
}

const MAX_TASKS = 20;
const MAX_DURATION_MS = 30_000;
const TICKS = 5;

function parse(data: unknown): DemoPayload {
  const raw = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const tasks = Number(raw.tasks);
  const durationMs = Number(raw.durationMs);
  return {
    tasks: Number.isFinite(tasks) ? Math.min(Math.max(Math.floor(tasks), 1), MAX_TASKS) : 3,
    durationMs: Number.isFinite(durationMs) ? Math.min(Math.max(durationMs, 0), MAX_DURATION_MS) : 1_000,
    label: typeof raw.label === "string" ? raw.label : "demo",
    fail: raw.fail === true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fan out `tasks` children, and one report waiting on all of them. */
const start: StepSpec = {
  name: "start",
  description: "Fan out the demo tasks",
  jobOptions: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 50 } },
  run: async ({ payload, flow, log: line }) => {
    const demo = parse(payload);
    await line(`fanning out ${demo.tasks} task(s)`);
    await flow({
      step: "report",
      data: { label: demo.label },
      children: Array.from({ length: demo.tasks }, (_, i) => ({
        step: "task",
        data: { ...demo, index: i + 1 },
      })),
    });
    return { tasks: demo.tasks, label: demo.label };
  },
};

/** One unit of pretend work, reporting progress as it goes. */
const task: StepSpec = {
  name: "task",
  description: "Sleep, tick progress, and optionally fail",
  jobOptions: {
    // Three attempts with a short backoff: enough to watch a retry happen in the
    // board without waiting around for it.
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  },
  run: async ({ payload, progress }) => {
    const demo = parse(payload);
    const raw = payload as { index?: number };
    for (let i = 1; i <= TICKS; i++) {
      await sleep(Math.round(demo.durationMs / TICKS));
      await progress(i / TICKS);
    }
    if (demo.fail) {
      throw new Error(`demo task ${raw.index ?? "?"} asked to fail (label=${demo.label})`);
    }
    return { index: raw.index ?? 0, label: demo.label };
  },
};

/** Fold what the tasks returned. Runs once every one of them has settled. */
const report: StepSpec = {
  name: "report",
  description: "Fold the task results into one return value",
  jobOptions: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 50 } },
  run: async ({ payload, children, log: line }) => {
    const results = await children();
    const raw = payload as { label?: string };
    const summary = {
      label: raw.label ?? "demo",
      completed: results.values.length,
      failed: results.failures.length,
      finishedAt: new Date().toISOString(),
    };
    await line(`${summary.completed} completed, ${summary.failed} failed`);
    log.info("demo complete", { ...summary });
    return summary;
  },
};

export const demo = defineWorkflow({
  name: "demo",
  description: "No-op fan-out — proves the queue, the flow, the workers and the board are wired together",
  entry: "start",
  steps: [start, task, report],
});
