import { z } from "zod";
import fp from "fastify-plugin";

/**
 * Environment parsing, service-wide (D2). Replaces `#/env.ts` (the
 * `.env`-file load) and the former `#/config.ts` (`loadConfig`) — both
 * collapse into one zod schema, decorated as `fastify.env`. The autoscaler's
 * own opt-in settings are the one thing not folded in: they read off this
 * schema in `lib/railway/config.ts`, next to the only code that uses them.
 *
 * `process.loadEnvFile` runs first, exactly where `#/env.ts` ran it, so
 * `services/pipeline/.env` is loaded before anything reads `process.env` —
 * including every other plugin, since `env` has no dependencies and autoload
 * has nothing to order it against but its own file name. Absent on Railway,
 * where the platform's environment stands alone; an already-set variable
 * always wins because `loadEnvFile` never overwrites.
 */
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // No .env file present — rely on the ambient environment.
}

const positiveInt = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const parsed = Number(v);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
    });

const schema = z
  .object({
    NODE_ENV: z.string().optional(),
    REDIS_URL: z.string().min(1, "REDIS_URL is not set"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is not set"),

    PORT: positiveInt(3002),
    PIPELINE_HOST: z.string().optional(),
    PIPELINE_AUTH_USER: z.string().optional(),
    PIPELINE_AUTH_PASSWORD: z.string().optional(),
    PIPELINE_WORKER_CONCURRENCY: positiveInt(4),

    ATPROTO_PLC_URL: z.string().optional(),
    RELAY_URL: z.string().optional(),
    SYNC_CONCURRENCY: z.string().optional(),
    SYNC_MAX_REPOS: z.string().optional(),
    SYNC_ONLY_DID: z.string().optional(),
    SYNC_PDS_URL: z.string().optional(),
    ATPROTO_SYNC_SCHEDULE: z.string().optional(),
    ATPROTO_SYNC_MAX_IN_FLIGHT: z.string().optional(),

    LLM_ENRICHMENT_PROVIDER: z.string().optional(),
    LLM_ENRICHMENT_MODEL: z.string().optional(),
    LLM_ENRICHMENT_ENABLED: z.string().optional(),
    MOONSHOT_API_KEY: z.string().optional(),
    MOONSHOT_BASE_URL: z.string().optional(),
    LLM_INPUT_TOKEN_PRICE_USD: z.string().optional(),
    LLM_OUTPUT_TOKEN_PRICE_USD: z.string().optional(),
    RECIPE_ENRICHMENT_MAX_IN_FLIGHT: z.string().optional(),

    POSTHOG_ENABLED: z.string().optional(),
    POSTHOG_PROJECT_TOKEN: z.string().optional(),
    POSTHOG_HOST: z.string().optional(),
    POSTHOG_PERSONAL_API_KEY: z.string().optional(),
    POSTHOG_APP_HOST: z.string().optional(),

    RAILWAY_API_TOKEN: z.string().optional(),
    RAILWAY_PROJECT_ID: z.string().optional(),
    RAILWAY_ENVIRONMENT_ID: z.string().optional(),
    RAILWAY_REPLICA_ID: z.string().optional(),
    AUTOSCALE_TARGET_SERVICE: z.string().optional(),
    AUTOSCALE_TARGET_SERVICE_ID: z.string().optional(),
    AUTOSCALE_MIN_REPLICAS: z.string().optional(),
    AUTOSCALE_MAX_REPLICAS: z.string().optional(),
    AUTOSCALE_BACKLOG_PER_REPLICA: z.string().optional(),
    AUTOSCALE_INTERVAL_SECONDS: z.string().optional(),
    AUTOSCALE_SCALE_DOWN_COOLDOWN_SECONDS: z.string().optional(),
    AUTOSCALE_DRY_RUN: z.string().optional(),
  })
  .loose();

export type Env = z.infer<typeof schema> & {
  PRODUCTION: boolean;
};

function parseEnv(): Env {
  const parsed = schema.parse(process.env);
  const production = parsed.NODE_ENV === "production";

  // The board exposes every job payload and lets a visitor retry, promote and
  // delete jobs, so it is never left open on a deployed service (was
  // `loadConfig`'s own check).
  if (production && !parsed.PIPELINE_AUTH_PASSWORD) {
    throw new Error("PIPELINE_AUTH_PASSWORD is required in production — the Bull Board UI must not be public");
  }

  return { ...parsed, PRODUCTION: production };
}

export default fp(
  (fastify) => {
    fastify.decorate("env", Object.freeze(parseEnv()));
  },
  { name: "env" },
);

declare module "fastify" {
  interface FastifyInstance {
    env: Readonly<Env>;
  }
}
