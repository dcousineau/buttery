import type { Env } from "#/plugins/env.ts";

/**
 * Autoscaler settings, read off `fastify.env`.
 *
 * Separate from the rest of the environment because the whole feature is
 * opt-in: without a Railway API token there is nothing to scale and the loop
 * never starts — which is why this returns `undefined` rather than throwing,
 * and why `plugins/env.ts` types every `AUTOSCALE_*`/`RAILWAY_*` variable as
 * optional. See `lib/railway/autoscale.ts` for why it lives in the server
 * process.
 *
 * The values arrive here as the strings the schema validated, not as numbers:
 * these are the only variables in the service whose defaults depend on each
 * other (`maxReplicas` is floored at `minReplicas`), so the coercion happens
 * once, here, where that relationship is visible.
 */

function int(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

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

export function loadAutoscaleConfig(env: Env): AutoscaleConfig | undefined {
  const apiToken = env.RAILWAY_API_TOKEN;
  if (!apiToken) return undefined;

  const minReplicas = int(env.AUTOSCALE_MIN_REPLICAS, 1);
  // Railway caps a service at 50 replicas across all regions; the default here
  // is deliberately far below that — raise it once a real backlog justifies it.
  const maxReplicas = Math.max(minReplicas, int(env.AUTOSCALE_MAX_REPLICAS, 5));

  return {
    apiToken,
    // Both are injected into every Railway container; the autoscaler only runs
    // there, so they are read rather than configured.
    projectId: env.RAILWAY_PROJECT_ID,
    environmentId: env.RAILWAY_ENVIRONMENT_ID,
    targetServiceName: env.AUTOSCALE_TARGET_SERVICE ?? "pipeline-worker",
    targetServiceId: env.AUTOSCALE_TARGET_SERVICE_ID || undefined,
    minReplicas,
    maxReplicas,
    backlogPerReplica: int(env.AUTOSCALE_BACKLOG_PER_REPLICA, 25),
    intervalMs: int(env.AUTOSCALE_INTERVAL_SECONDS, 60) * 1000,
    scaleDownCooldownMs: int(env.AUTOSCALE_SCALE_DOWN_COOLDOWN_SECONDS, 300) * 1000,
    /** `true` only for the literal string "true" — anything else, including unset, is off. */
    dryRun: env.AUTOSCALE_DRY_RUN === "true",
  };
}
