import { getDb } from "#/lib/db";
import { safeFetch, type SafeFetchResult } from "./safe-fetch";

/**
 * DB-backed raw-HTML cache in front of `safeFetch` (plan §B, user request).
 * Server-only (imports the DB) — call from server fns / the future scrape worker.
 *
 * A cache hit skips the network entirely; a miss fetches (SSRF-guarded), stores
 * the raw body, and returns it. Keeping the raw HTML means an improved extractor
 * or a new per-host adapter can re-parse old pages without re-crawling.
 */

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

export interface FetchedPage extends SafeFetchResult {
  /** The normalized cache key we stored/looked up under. */
  cacheUrl: string;
  fromCache: boolean;
}

export interface FetchPageOptions {
  /** Serve a cached body if it's younger than this. 0 forces a fresh fetch. */
  maxAgeMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Normalize a URL to a stable cache key: drop the fragment, lowercase the host. */
export function normalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  return u.toString();
}

function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Fetch a recipe page through the cache. Throws `SafeFetchError` on fetch failure. */
export async function fetchRecipePage(rawUrl: string, opts: FetchPageOptions = {}): Promise<FetchedPage> {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const cacheUrl = normalizeUrl(rawUrl);
  const db = getDb();

  if (maxAgeMs > 0) {
    const row = await db.selectFrom("recipe_fetch_cache").selectAll().where("url", "=", cacheUrl).executeTakeFirst();
    if (row && Date.now() - new Date(row.fetched_at).getTime() < maxAgeMs) {
      return {
        cacheUrl,
        fromCache: true,
        finalUrl: row.final_url ?? cacheUrl,
        status: row.http_status ?? 200,
        contentType: row.content_type,
        body: row.body,
        byteSize: row.byte_size ?? row.body.length,
      };
    }
  }

  const fetched = await safeFetch(cacheUrl, { timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes });

  await db
    .insertInto("recipe_fetch_cache")
    .values({
      url: cacheUrl,
      host: hostOf(cacheUrl),
      final_url: fetched.finalUrl,
      http_status: fetched.status,
      content_type: fetched.contentType,
      body: fetched.body,
      byte_size: fetched.byteSize,
      fetched_at: new Date(),
    })
    .onConflict((oc) =>
      oc.column("url").doUpdateSet({
        host: hostOf(cacheUrl),
        final_url: fetched.finalUrl,
        http_status: fetched.status,
        content_type: fetched.contentType,
        body: fetched.body,
        byte_size: fetched.byteSize,
        fetched_at: new Date(),
      }),
    )
    .execute();

  return { ...fetched, cacheUrl, fromCache: false };
}
