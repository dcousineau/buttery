import { Redis } from "ioredis";
import fp from "fastify-plugin";

/**
 * The service-wide Redis client (S1). Replaces `src/redis.ts`'s
 * `getRedis`/`requireRedis`/`closeRedis` lazy singleton with a decorator that
 * exists once `env` has run, so there is no `requireRedis`-style "did anyone
 * call this first" ordering contract left to enforce with a thrown error —
 * Fastify's own dependency graph is the enforcement.
 *
 * `maxRetriesPerRequest: null` and `enableReadyCheck: false` are load-bearing,
 * not stylistic, and are carried over verbatim from `src/redis.ts`:
 *
 * - `maxRetriesPerRequest: null` — BullMQ's blocking `BRPOPLPUSH` outlives any
 *   finite per-request retry budget, and ioredis's default of 20 makes a
 *   worker throw `MaxRetriesPerRequestError` the moment Redis blips. Null lets
 *   commands queue through a reconnect instead.
 * - `enableReadyCheck: false` — Railway's Redis can answer `INFO` with
 *   `loading:1` during a restart, which the ready check treats as fatal
 *   rather than as something to wait out.
 */
export default fp(
  (fastify) => {
    const client = new Redis(fastify.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

    fastify.decorate("redis", client);

    fastify.addHook("onClose", async () => {
      await client.quit();
    });
  },
  { name: "redis", dependencies: ["env"] },
);

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}
