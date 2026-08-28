import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { FastifyBaseLogger } from "fastify";

/**
 * A Redis mutex, held across the worker fleet — and, unlike the usual shape,
 * across *executions*.
 *
 * BullMQ stops the same job running twice, but it does not stop two different
 * jobs on the same queue running at once — which is exactly what an hourly
 * schedule plus a long-running workflow plus two replicas produces. The Railway
 * cron this replaces got that guarantee from the platform (a scheduled run is
 * skipped while the previous deployment is still active), so losing it would be
 * a regression, not a new risk. Hence this.
 *
 * Acquire and release are split rather than wrapped in a `withLock(fn)` because
 * the holder is not a function call: it is a graph of jobs. One step takes the
 * lock, another one — minutes later, on another machine — gives it back, and the
 * token travels between them in the flow's own job data.
 *
 * The shape is otherwise standard: SET NX PX with a random token, and a
 * compare-and-delete on release so a slow holder cannot free someone else's
 * lock. Nothing heartbeats it, because there is no process to heartbeat from,
 * which makes the TTL a plain deadline rather than a liveness check. Size it to
 * the schedule's period: what it then says is "a run may not start while the
 * last one is still going, up to one period", and a run that outlasts its own
 * interval is already the pathological case.
 */

/** Delete only if we still hold the lock. */
const RELEASE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

/** Take the lock, or return undefined if someone else holds it. */
export async function acquireLock(redis: Redis, key: string, ttlMs: number): Promise<string | undefined> {
  const token = randomUUID();
  const acquired = await redis.set(key, token, "PX", ttlMs, "NX");
  return acquired === "OK" ? token : undefined;
}

export async function releaseLock(redis: Redis, key: string, token: string, log: FastifyBaseLogger): Promise<void> {
  await redis.eval(RELEASE, 1, key, token).catch((err: unknown) => {
    // The TTL is the backstop: an unreleased lock frees itself.
    log.warn({ key, err: String(err) }, "lock release failed");
  });
}
