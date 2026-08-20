import { Redis } from "ioredis";
import type { ConnectionOptions } from "bullmq";

// BullMQ's connection. Every Queue, Worker and QueueEvents in this service
// shares one ioredis client, which is what BullMQ recommends for a single
// process: it multiplexes commands over one socket, and blocking reads get
// their own duplicated connection automatically.
//
// `maxRetriesPerRequest: null` is REQUIRED, not a preference — BullMQ's blocking
// `BRPOPLPUSH` outlives any finite per-request retry budget, and ioredis's
// default of 20 makes a worker throw `MaxRetriesPerRequestError` the moment
// Redis blips. Null lets commands queue through a reconnect instead.
//
// `enableReadyCheck: false` for the same class of reason: Railway's Redis can
// answer INFO with `loading:1` during a restart, which the ready check treats as
// fatal rather than as something to wait out.

let client: Redis | undefined;

export function getRedis(url: string): Redis {
  if (!client) {
    client = new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
  return client;
}

/**
 * The shared client, for code that runs after an entrypoint has already created
 * it and has no business knowing the URL — a job handler, chiefly.
 */
export function requireRedis(): Redis {
  if (!client) {
    throw new Error("Redis has not been initialised — an entrypoint must call getRedis() first");
  }
  return client;
}

/** BullMQ takes the shared client directly, so nothing here opens a second socket. */
export function connectionFor(url: string): ConnectionOptions {
  return getRedis(url);
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = undefined;
  }
}
