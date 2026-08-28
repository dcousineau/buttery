// Environment parsing for both entrypoints (server.ts and worker.ts). Node runs
// this `.ts` directly (type-stripping) — keep everything erasable (no enum /
// namespace / parameter properties).

// Local dev config comes from this package's `.env` (see `.env.example`), read
// once by `#/env.ts` — including the variables the workflows themselves consume
// (DATABASE_URL, RELAY_URL, SYNC_*), which used to live in a `.env` of their own.
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

export interface ServerConfig {
  port: number;
  host: string;
  /** Basic-auth credentials for the Bull Board UI and the job API. */
  auth: { username: string; password: string } | undefined;
}

export interface WorkerConfig {
  /** Jobs a single worker process handles at once. */
  concurrency: number;
}

export interface Config {
  redisUrl: string;
  /** `production` on Railway; anything else is treated as local dev. */
  production: boolean;
  server: ServerConfig;
  worker: WorkerConfig;
}

export function loadConfig(): Config {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is not set");
  }

  const production = process.env.NODE_ENV === "production";

  const username = process.env.PIPELINE_AUTH_USER;
  const password = process.env.PIPELINE_AUTH_PASSWORD;

  // The board exposes every job payload and lets a visitor retry, promote and
  // delete jobs, so it is never left open on a deployed service. Locally an
  // unset password means "no auth" — the whole stack is already loopback-only.
  if (production && !password) {
    throw new Error("PIPELINE_AUTH_PASSWORD is required in production — the Bull Board UI must not be public");
  }

  return {
    redisUrl,
    production,
    server: {
      port: int("PORT", 3002),
      // Railway routes to the container's published port, which needs a
      // non-loopback bind; locally 127.0.0.1 keeps it off the LAN.
      host: process.env.PIPELINE_HOST ?? (production ? "0.0.0.0" : "127.0.0.1"),
      auth: password ? { username: username ?? "buttery", password } : undefined,
    },
    worker: {
      concurrency: int("PIPELINE_WORKER_CONCURRENCY", 4),
    },
  };
}

/**
 * Autoscaler settings. Separate from `Config` because the whole feature is
 * opt-in: without a Railway API token there is nothing to scale and the loop
 * never starts. See `lib/railway/autoscale.ts` for why this lives in the server process.
 */
export interface AutoscaleConfig {
  apiToken: string;
  projectId: string | undefined;
  environmentId: string | undefined;
  /** Service to scale, by name — resolved to an id through the API on first run. */
  targetServiceName: string;
  /** Skips name resolution when set. */
  targetServiceId: string | undefined;
  minReplicas: number;
  maxReplicas: number;
  /** Backlog (waiting + active + delayed-due) one replica is expected to absorb. */
  backlogPerReplica: number;
  intervalMs: number;
  /** Quiet period after a scale-down before another one is allowed. */
  scaleDownCooldownMs: number;
  /** `--dry-run` equivalent: decide and log, never call the mutation. */
  dryRun: boolean;
}

export function loadAutoscaleConfig(): AutoscaleConfig | undefined {
  const apiToken = process.env.RAILWAY_API_TOKEN;
  if (!apiToken) return undefined;

  const minReplicas = int("AUTOSCALE_MIN_REPLICAS", 1);
  // Railway caps a service at 50 replicas across all regions; the default here
  // is deliberately far below that — raise it once a real backlog justifies it.
  const maxReplicas = Math.max(minReplicas, int("AUTOSCALE_MAX_REPLICAS", 5));

  return {
    apiToken,
    // Both are injected into every Railway container; the autoscaler only runs
    // there, so they are read rather than configured.
    projectId: process.env.RAILWAY_PROJECT_ID,
    environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
    targetServiceName: process.env.AUTOSCALE_TARGET_SERVICE ?? "pipeline-worker",
    targetServiceId: process.env.AUTOSCALE_TARGET_SERVICE_ID || undefined,
    minReplicas,
    maxReplicas,
    backlogPerReplica: int("AUTOSCALE_BACKLOG_PER_REPLICA", 25),
    intervalMs: int("AUTOSCALE_INTERVAL_SECONDS", 60) * 1000,
    scaleDownCooldownMs: int("AUTOSCALE_SCALE_DOWN_COOLDOWN_SECONDS", 300) * 1000,
    dryRun: bool("AUTOSCALE_DRY_RUN"),
  };
}
