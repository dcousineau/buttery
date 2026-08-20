import { log } from "#/log.ts";

// Polite network citizen (plan §1 "Concurrency & ordering"): short per-request
// timeout, one retry with a short backoff on 429/5xx and transient network
// errors. Everything the sweep fetches is public and unauthenticated.
//
// Deliberately shallow, because this is the INNER of two retry loops: the
// activity calling it has a retry policy of its own, and that is the one worth
// having — it is visible on the timeline, it backs off in minutes rather than
// milliseconds, and it survives the worker dying. Four attempts here against
// three there meant a hung host cost twelve 15-second timeouts before anyone
// gave up. One retry covers the packet that got dropped; anything longer-lived
// is Temporal's to wait out.

// Measured against the live network: a healthy PDS answers one of these in
// ~700 ms (p50) and ~1 s (p90). Eight seconds is ten times the p90 — long enough
// that a slow-but-alive host still gets served, short enough that a host which
// accepts the connection and then hangs is abandoned before it costs the sweep
// anything. It was 15 s, which is where a single hung repo's 25-second attempts
// came from.
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Thrown when a request exhausts retries or hits a non-retryable status. */
export class HttpError extends Error {
  status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
  } finally {
    clearTimeout(timer);
  }
}

/** GET `url` and parse JSON, retrying transient failures. */
export async function getJson<T>(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchWithTimeout(url, timeoutMs);
      if (res.ok) {
        return (await res.json()) as T;
      }
      // 429 + 5xx are transient; 4xx (except 429) are not — fail fast.
      if (res.status !== 429 && res.status < 500) {
        throw new HttpError(`GET ${url} → HTTP ${res.status}`, res.status);
      }
      lastErr = new HttpError(`GET ${url} → HTTP ${res.status}`, res.status);
    } catch (err) {
      if (err instanceof HttpError && err.status !== undefined && err.status !== 429 && err.status < 500) {
        throw err; // non-retryable
      }
      lastErr = err;
    }

    if (attempt < MAX_ATTEMPTS) {
      const backoff = 250 * 2 ** (attempt - 1); // 250 ms
      log.warn("http retry", { url, attempt, backoff, err: String(lastErr) });
      await sleep(backoff);
    }
  }
  throw lastErr instanceof Error ? lastErr : new HttpError(`GET ${url} failed`, undefined);
}
