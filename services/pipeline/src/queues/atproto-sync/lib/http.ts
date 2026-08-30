import { log } from "#/lib/log.ts";

// Polite network citizen (plan §1 "Concurrency & ordering"): short per-request
// timeout, bounded retries with exponential backoff on 429/5xx and transient
// network errors. Everything the sweep fetches is public and unauthenticated.

// Sized off a measured sweep rather than a guess: a healthy repo answers in
// ~700ms (p50) and ~1s (p90), so eight seconds is generous for anything that is
// going to answer at all. What it is really protecting against is the host that
// accepts the connection and then hangs — there are a few on the live network —
// which under a fifteen-second timeout was costing half a minute per repo.
const DEFAULT_TIMEOUT_MS = 8_000;

// Two, not four, because this is no longer the only retry in the stack: one repo
// is one job with its own `attempts` and backoff (see `steps.ts`). These cover
// the blip that a second request fixes; a host that is genuinely down is the
// job's problem, and multiplying the two retry budgets together is how a single
// dead PDS ends up costing minutes.
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
