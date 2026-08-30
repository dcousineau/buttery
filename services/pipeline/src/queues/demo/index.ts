import fp from "fastify-plugin";
import { UnrecoverableError, type Job } from "bullmq";
import type { FastifyInstance } from "fastify";

/**
 * A do-nothing queue that exists to prove the wiring works end to end:
 * enqueue → a worker picks it up → it fans out → the children run → the report
 * folds them, all visible in the Bull Board UI. It is the fastest way to answer
 * "is the deployed board actually talking to the worker fleet, or just to
 * Redis?", and it answers it in a shape a real queue uses:
 *
 *     start ──fans out──▶ task × N ──▶ report
 *
 * It stays registered in production on purpose. The queue is empty unless
 * someone posts to it, and `POST /jobs/demo` sits behind the same basic auth as
 * the board, so the cost is one idle queue key in Redis.
 */

const QUEUE_NAME = "demo";
const START_JOB = "start";
const TASK_JOB = "task";
const REPORT_JOB = "report";

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

interface ReportPayload {
  label: string;
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
async function start(fastify: FastifyInstance, job: Job<DemoPayload>): Promise<{ tasks: number; label: string }> {
  const demo = parse(job.data);
  await job.log(`fanning out ${demo.tasks} task(s)`);
  await fastify.bullmq.flow.add({
    name: REPORT_JOB,
    queueName: QUEUE_NAME,
    data: { label: demo.label } satisfies ReportPayload,
    opts: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 50 } },
    children: Array.from({ length: demo.tasks }, (_, i) => ({
      name: TASK_JOB,
      queueName: QUEUE_NAME,
      data: { ...demo, index: i + 1 },
      opts: {
        // Three attempts with a short backoff: enough to watch a retry happen
        // in the board without waiting around for it.
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
        // NOT a BullMQ default — a failed child normally leaves its parent
        // waiting forever, since "waiting children" has no timeout of its own.
        // The old kernel set this on every flow child automatically, so a
        // failed step was stepped over and counted by the parent rather than
        // wedging the run. `--fail` exists specifically to exercise that path,
        // so it has to be requested here explicitly per child now that there
        // is no kernel to default it for us.
        ignoreDependencyOnFailure: true,
      },
    })),
  });
  return { tasks: demo.tasks, label: demo.label };
}

/** One unit of pretend work, reporting progress as it goes. */
async function task(job: Job<DemoPayload & { index: number }>): Promise<{ index: number; label: string }> {
  const demo = parse(job.data);
  for (let i = 1; i <= TICKS; i++) {
    await sleep(Math.round(demo.durationMs / TICKS));
    // `job.updateProgress` wants 0..100, not the 0..1 fraction the old
    // `ctx.progress()` took — the host used to do that multiplication for
    // every step; each call site does it for itself now.
    await job.updateProgress(Math.round((i / TICKS) * 100));
  }
  if (demo.fail) {
    throw new Error(`demo task ${job.data.index ?? "?"} asked to fail (label=${demo.label})`);
  }
  return { index: job.data.index ?? 0, label: demo.label };
}

/** Fold what the tasks returned. Runs once every one of them has settled. */
async function report(fastify: FastifyInstance, job: Job<ReportPayload>): Promise<Record<string, unknown>> {
  // `getChildrenValues` and `getIgnoredChildrenFailures` both key their result
  // by child job key, not by index — `Object.values` is the fan-in the old
  // `ctx.children()` used to do for us.
  const values = await job.getChildrenValues();
  const failures = await job.getIgnoredChildrenFailures();
  const summary = {
    label: job.data.label ?? "demo",
    completed: Object.values(values).length,
    failed: Object.values(failures).length,
    finishedAt: new Date().toISOString(),
  };
  await job.log(`${summary.completed} completed, ${summary.failed} failed`);
  fastify.log.info({ ...summary }, "demo complete");
  return summary;
}

export default fp(
  (fastify) => {
    fastify.bullmq.queue({
      name: QUEUE_NAME,
      description: "No-op fan-out — proves the queue, the flow, the workers and the board are wired together",
      jobs: [
        { name: START_JOB, description: "Fan out the demo tasks" },
        { name: TASK_JOB, description: "Sleep, tick progress, and optionally fail" },
        { name: REPORT_JOB, description: "Fold the task results into one return value" },
      ],
      defaultJob: START_JOB,
      defaultJobOptions: { removeOnComplete: { count: 50 }, removeOnFail: { count: 50 } },
    });

    fastify.bullmq.worker(QUEUE_NAME, async (job) => {
      switch (job.name) {
        case START_JOB:
          // `fastify.bullmq.worker` hands every job through as the same
          // `Job<any, any, string>` — one processor per queue dispatches on
          // `job.name`, so it cannot know each job's payload shape ahead of
          // time. Each handler below owns validating its own `job.data`
          // (`parse()`, for the two demo-shaped ones), so this cast just
          // names the shape that validation is about to check, rather than
          // asserting it is already true.
          return start(fastify, job as Job<DemoPayload>);
        case TASK_JOB:
          return task(job as Job<DemoPayload & { index: number }>);
        case REPORT_JOB:
          return report(fastify, job as Job<ReportPayload>);
        default:
          // Should be unreachable — `POST /jobs/demo` and `cli/trigger.ts`
          // both validate `job.name` against the registration before adding
          // it. `UnrecoverableError` skips retries: a job with a name this
          // processor has never heard of will not resolve itself by trying again.
          throw new UnrecoverableError(`queue "${QUEUE_NAME}" has no job "${job.name}"`);
      }
    });
  },
  { name: "queue-demo", dependencies: ["bullmq"] },
);
