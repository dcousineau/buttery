import Redis from "ioredis";

// Server-only module: reads REDIS_URL from the process environment.
// On Railway this is injected from the redis service (see .railway/railway.ts);
// locally set it in .env (a public/proxied URL, since the private
// `*.railway.internal` host is only reachable inside Railway).
//
// Single shared Redis entry point for the app. Backs the scrape rate limiter
// (SET NX PX per-account key) and a general-purpose cache. The client is a
// lazily created singleton so a serverless/SSR request reuses one connection.
let client: Redis | undefined;

/** Shared ioredis client — the single Redis entry point for the app. */
export function getRedis(): Redis {
  if (!client) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error("REDIS_URL is not set");
    }
    // lazyConnect so importing this module never opens a socket; the first
    // command connects. maxRetriesPerRequest null lets commands queue during a
    // brief reconnect instead of throwing.
    client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null });
  }
  return client;
}
