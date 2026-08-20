// Environment parsing for every entrypoint (worker.ts, schedules-sync.ts,
// run-once.ts). Node runs this `.ts` directly (type-stripping) — keep everything
// erasable (no enum / namespace / parameter properties).
//
// Local dev config comes from this package's `.env` (see `.env.example`), read
// once by `#/env.ts` — including the variables the workflows themselves consume
// (DATABASE_URL, RELAY_URL, SYNC_*), which used to live in a `.env` of their own
// back when the sweep was its own service.
import "#/env.ts";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** `true` only for the literal string "true" — anything else, including unset, is off. */
function bool(name: string): boolean {
  return process.env[name] === "true";
}

export interface TemporalConfig {
  /** `host:port` of the Temporal frontend's gRPC endpoint. */
  address: string;
  namespace: string;
  /**
   * The queue workers poll and workflows are started on. One queue for the whole
   * service: a task queue is a routing key, not a unit of isolation, and every
   * workflow here wants the same fleet. Splitting it is how you give one workflow
   * dedicated capacity (or a machine with different hardware), which nothing here
   * needs yet.
   */
  taskQueue: string;
  /**
   * TLS to the frontend. Off by default: on Railway the worker reaches Temporal
   * over the project's private network, which never leaves the platform. Turn it
   * on (plus `TEMPORAL_API_KEY`) to point this same worker at Temporal Cloud.
   */
  tls: boolean;
  apiKey: string | undefined;
}

export interface WorkerTuning {
  /**
   * Activity executions this process runs at once. This is the knob that made
   * the BullMQ build's autoscaler mostly unnecessary: a worker pulls work when it
   * has capacity rather than being handed jobs, so a backlog waits in Temporal
   * instead of piling into a process that cannot keep up.
   */
  maxConcurrentActivityTaskExecutions: number;
  /**
   * Workflow tasks at once. Workflow tasks are short and CPU-bound (they replay
   * history and decide the next command), so this stays well below the activity
   * number.
   */
  maxConcurrentWorkflowTaskExecutions: number;
  /**
   * How long `worker.run()` waits for in-flight activities after a SIGTERM
   * before cancelling them. Railway's drain window is 30s by default, so this
   * sits inside it — an activity that has not finished by then is retried on
   * another replica, which is the whole point of activities being retryable.
   */
  shutdownGraceTimeMs: number;
}

export interface Config {
  /** `production` on Railway; anything else is treated as local dev. */
  production: boolean;
  temporal: TemporalConfig;
  worker: WorkerTuning;
}

export function loadConfig(): Config {
  return {
    production: process.env.NODE_ENV === "production",
    temporal: {
      // Defaults to the `temporal server start-dev` address, so a fresh clone
      // with the local stack up needs no configuration at all.
      address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
      namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
      taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "buttery",
      tls: bool("TEMPORAL_TLS"),
      apiKey: process.env.TEMPORAL_API_KEY || undefined,
    },
    worker: {
      maxConcurrentActivityTaskExecutions: int("WORKER_MAX_CONCURRENT_ACTIVITIES", 8),
      maxConcurrentWorkflowTaskExecutions: int("WORKER_MAX_CONCURRENT_WORKFLOW_TASKS", 4),
      shutdownGraceTimeMs: int("WORKER_SHUTDOWN_GRACE_SECONDS", 20) * 1000,
    },
  };
}
