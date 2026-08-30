import { Redis } from "ioredis";
import fp from "fastify-plugin";
import type { PipelineRole } from "#/plugins/bullmq.ts";

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
 *
 * ── THE CLI IS THE EXCEPTION, AND HAS TO BE ────────────────────────────────
 *
 * Both settings above are right for a long-lived server or worker and WRONG
 * for a one-shot command. Together with ioredis's default infinite
 * `retryStrategy` they mean a command issued against a Redis that is not
 * running does not fail — it sits in the offline queue waiting for a
 * reconnect that may never come. A worker riding out a blip is exactly what
 * that is for; `cli/trigger.ts` hanging forever instead of saying "Redis is
 * not reachable" is not.
 *
 * So the `cli` role gets a bounded retry strategy: a few quick attempts, then
 * give up and let the error surface. The CLI's whole premise is that a server
 * and a worker are already running, which makes "I cannot reach Redis" a
 * useful answer and an indefinite wait a useless one.
 *
 * Found by an agent who stopped the container and watched `trigger` hang past
 * 120 seconds, still alive — it is recorded in the decision journal as a
 * defect against the old shared client.
 */

/** How many times the one-shot CLI retries a connection before giving up. */
const CLI_MAX_CONNECT_ATTEMPTS = 3;
interface RedisPluginOptions {
  role?: PipelineRole;
}

export default fp(
  (fastify, opts: RedisPluginOptions) => {
    const isCli = opts.role === "cli";

    const client = new Redis(fastify.env.REDIS_URL, {
      // A CLI wants a bounded budget for the same reason a worker wants none:
      // one is a command that should answer, the other is a process that
      // should survive. `1` rather than `null` here so a command against a
      // dead Redis rejects instead of queueing.
      maxRetriesPerRequest: isCli ? 1 : null,
      enableReadyCheck: false,
      ...(isCli
        ? {
            // Give up after a few quick attempts. Returning `null` from
            // `retryStrategy` is ioredis's "stop retrying" signal, which is
            // what turns the hang into an error the caller can report.
            retryStrategy: (times: number) => (times > CLI_MAX_CONNECT_ATTEMPTS ? null : Math.min(times * 200, 1_000)),
            // Without this, a command issued before the first connection
            // completes waits for a connection that is no longer being
            // attempted.
            enableOfflineQueue: false,
          }
        : {}),
    });

    // ioredis emits `error` on every failed connection attempt, and an
    // EventEmitter with no `error` listener throws — so this is registered for
    // every role, not just the CLI. The server and worker also have BullMQ's
    // own `Worker`/`Queue` listeners, but those cover BullMQ's connections,
    // not this one.
    //
    // `debug`, not `warn`: a reconnect storm would otherwise write a line per
    // attempt, and for the long-lived roles riding out a blip is the intended
    // behaviour rather than something to report. When it actually matters —
    // the CLI giving up — the caller reports it, with context this listener
    // does not have.
    client.on("error", (err: Error) => {
      fastify.log.debug({ err: err.message }, "redis connection error");
    });

    fastify.decorate("redis", client);

    fastify.addHook("onClose", async () => {
      // `quit()` sends QUIT and waits for the reply, which THROWS when the
      // connection is already gone or was never established — and a throw here
      // escapes the close hook and takes the process down before whoever
      // called `app.close()` can report why they were shutting down in the
      // first place. That is exactly the CLI-against-a-dead-Redis case: the
      // real error is "cannot reach Redis", and an unhandled quit failure
      // would replace that message with its own stack.
      //
      // So: try the graceful goodbye, and fall back to dropping the socket.
      // Shutting down must not be able to fail because the thing we are
      // disconnecting from is already unreachable.
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    });
  },
  { name: "redis", dependencies: ["env"] },
);

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}
