// Environment parsing for both entrypoints (worker.ts, schedules-sync.ts). Node
// runs this `.ts` directly (type-stripping) — keep everything erasable (no enum
// / namespace / parameter properties).
//
// Local config comes from this package's `.env` (see `.env.example`), read once
// by `#/env.ts`. Everything here is *environment*: where the cluster is, how big
// this process is allowed to get, what a sweep should reach for. What a single
// run should do is a workflow argument instead — see the input types under
// `workflows/`.
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

export interface Config {
  /** `production` on Railway; anything else is treated as local dev. */
  production: boolean;

  /** `host:port` of the Temporal frontend's gRPC endpoint. */
  address: string;
  /**
   * Namespaces are Temporal's isolation boundary — schedules, task queues,
   * workflow ids and retention are all scoped to one. Buttery gets its own
   * rather than sharing `default`, so "every schedule in this namespace" and
   * "every workflow in this namespace" are statements about *us*. It must exist
   * before a worker connects: locally `temporal server start-dev --namespace
   * buttery` creates it, on Railway auto-setup's `DEFAULT_NAMESPACE` does.
   */
  namespace: string;
  /**
   * The queue workers poll and workflows are started on. One queue for the whole
   * service: a task queue is a routing key, not a unit of isolation. Splitting it
   * is how you give one workflow dedicated capacity (or different hardware),
   * which nothing here needs yet.
   */
  taskQueue: string;
  /**
   * TLS to the frontend. Off by default: on Railway the worker reaches Temporal
   * over the project's private network, which never leaves the platform. Turn it
   * on (plus `TEMPORAL_API_KEY`) to point this same worker at Temporal Cloud.
   */
  tls: boolean;
  apiKey: string | undefined;

  /**
   * Activity executions this process runs at once. Workers pull work when they
   * have capacity, so this — not a replica count — is the first knob for
   * throughput; a backlog waits in Temporal rather than piling into the process.
   */
  maxConcurrentActivityTaskExecutions: number;
  /**
   * Workflow tasks at once. These are short and CPU-bound (they replay history
   * and decide the next command), so this stays well below the activity number.
   */
  maxConcurrentWorkflowTaskExecutions: number;
  /**
   * How long `worker.run()` waits for in-flight activities after a SIGTERM
   * before cancelling them. Railway's drain window is 30s by default, so this
   * sits inside it — an activity that has not finished by then is retried on
   * another worker, which is what activities are for.
   */
  shutdownGraceTimeMs: number;

  /** The app's database. Opened by `worker.ts` and handed to the activities. */
  databaseUrl: string;
}

export function loadConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  return {
    production: process.env.NODE_ENV === "production",

    // Defaults to the `temporal server start-dev` address, so a fresh clone with
    // the local stack up needs no configuration at all.
    address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
    namespace: process.env.TEMPORAL_NAMESPACE ?? "buttery",
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "buttery",
    tls: bool("TEMPORAL_TLS"),
    apiKey: process.env.TEMPORAL_API_KEY || undefined,

    maxConcurrentActivityTaskExecutions: int("WORKER_MAX_CONCURRENT_ACTIVITIES", 8),
    maxConcurrentWorkflowTaskExecutions: int("WORKER_MAX_CONCURRENT_WORKFLOW_TASKS", 4),
    shutdownGraceTimeMs: int("WORKER_SHUTDOWN_GRACE_SECONDS", 20) * 1000,

    databaseUrl,
  };
}
