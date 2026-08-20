import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { log } from "#/log.ts";

/**
 * A Redis mutex, held across the worker fleet.
 *
 * BullMQ stops the *same* job running twice, but it does not stop two
 * *different* jobs on the same queue running at once — which is exactly what an
 * autoscaled fleet plus a slow job produces: the scheduler enqueues the next
 * hourly sweep while the previous one is still going, a second replica picks it
 * up, and two sweeps write the same rows.
 *
 * The Railway cron this replaces got that guarantee from the platform (a
 * scheduled run is skipped while the previous deployment is still active), so
 * losing it would be a regression, not a new risk. Hence this.
 *
 * The shape is the standard one: SET NX PX with a random token, a compare-and-
 * delete on release so a slow holder cannot free someone else's lock, and a
 * heartbeat that extends the TTL while the work is genuinely still running. The
 * TTL is what makes a crashed holder recoverable; the heartbeat is what keeps
 * the TTL short enough for that to matter without capping how long a job may
 * take.
 */

/** Extend the TTL only if we still hold the lock. */
const RENEW = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

/** Delete only if we still hold the lock. */
const RELEASE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

export interface LockOptions {
  /** How long the lock survives a holder that stops heartbeating (i.e. crashed). */
  ttlMs: number;
}

/**
 * Runs `fn` under `key`, or returns `undefined` without running it if someone
 * else holds the lock. A caller that needs to tell "did not run" from "ran and
 * returned undefined" should have `fn` return something non-undefined.
 */
export async function withLock<T>(redis: Redis, key: string, options: LockOptions, fn: () => Promise<T>): Promise<T | undefined> {
  const token = randomUUID();
  const acquired = await redis.set(key, token, "PX", options.ttlMs, "NX");
  if (acquired !== "OK") return undefined;

  // A third of the TTL: two heartbeats may be lost to a Redis blip before the
  // lock is at risk of expiring under a holder that is still working.
  const heartbeat = setInterval(
    () => {
      redis.eval(RENEW, 1, key, token, options.ttlMs).catch((err: unknown) => {
        // Losing a renewal is not fatal on its own — the next one may land before
        // the TTL runs out — but it is worth seeing when a lock does expire early.
        log.warn("lock renewal failed", { key, err: String(err) });
      });
    },
    Math.max(1_000, Math.floor(options.ttlMs / 3)),
  );
  heartbeat.unref();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await redis.eval(RELEASE, 1, key, token).catch((err: unknown) => {
      // The TTL is the backstop: an unreleased lock frees itself.
      log.warn("lock release failed", { key, err: String(err) });
    });
  }
}
