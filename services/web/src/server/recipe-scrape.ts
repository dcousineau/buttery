import { createServerFn } from "@tanstack/react-start";
import type { ImportPrefill } from "#/lib/import-payload";

/**
 * Server-side recipe URL scrape (docs/plans/2026-08-02-create-recipes.md §B).
 *
 * Deliberately thin orchestration so the extraction stays a swappable module and
 * this can become a job-triggered worker later without touching the parser:
 *
 *   rate-limit (Redis) → fetch (SSRF-guarded, cached) → extract (pure package)
 *   → log the attempt (with the parsed prefill) → return an opaque import id.
 *
 * Every attempt — success or failure — is recorded in `recipe_import_attempt`
 * so we can see which hosts fail and where a bespoke extractor is worth building.
 * On success the parsed prefill is cached on that row; the client gets the row
 * `id` (the import id) and fetches the prefill back with `getImportPrefill` — the
 * payload never rides in the URL.
 *
 * Server-only deps are pulled in via dynamic import() inside the handler so the
 * SSRF/DB/Redis code never lands in the client bundle.
 */

export type ScrapeResult =
  // Full extraction: form fetches the prefill by id and treats it as a review.
  | { status: "ok"; importId: string }
  // Page fetched but no usable recipe body — we still cache title/image so the
  // manual fallback form isn't totally empty; attribution stays locked to the URL.
  | { status: "partial"; importId: string }
  // 1-per-60s per account tripped. Generic message ONLY — never leak the window.
  | { status: "rate_limited" }
  // SSRF guard rejected the target (private/internal address).
  | { status: "blocked"; message: string }
  // Network error, timeout, non-2xx, or too-large.
  | { status: "fetch_failed"; message: string }
  | { status: "invalid_url" };

export interface ScrapeRecipeInput {
  url: string;
}

/**
 * The Phase C bookmarklet ingest result. Same import-id handoff as `scrapeRecipe`
 * — the form loads the cached prefill by id — but the bytes come from the user's
 * own browser (no server fetch, no SSRF guard, no rate limit needed on the fetch).
 */
export type SubmitImportResult = { status: "ok"; importId: string } | { status: "partial"; importId: string } | { status: "invalid_url" } | { status: "empty" };

export interface SubmitImportInput {
  /** The recipe page's own URL (locks Website attribution to the source). */
  url: string;
  /** Raw JSON-LD text the bookmarklet found on the page, if any. */
  jsonld?: string;
  /** The page's serialized HTML, when no JSON-LD was found. */
  html?: string;
}

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 scrape per 60s per account.

export const scrapeRecipe = createServerFn({ method: "POST" })
  .validator((data: ScrapeRecipeInput) => ({ url: String(data?.url ?? "").trim() }))
  .handler(async ({ data }): Promise<ScrapeResult> => {
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    return runScrape(did, householdId, data.url);
  });

/**
 * Phase C bookmarklet ingest (docs/plans/2026-08-02-create-recipes.md §C3).
 *
 * The bookmarklet runs on a page Buttery can't fetch server-side, so it ships us
 * what it found: JSON-LD text if present, else the page's raw HTML. We normalize
 * either into HTML and run the SAME `extractRecipe` as the server scrape — one
 * parser, one code path — then cache the parse and hand back an import id. There
 * is deliberately NO server fetch here (the bytes are the user's own browser's),
 * so `safe-fetch` / the fetch cache / the scrape rate limit don't apply.
 *
 * Auth is required: the bookmarklet POSTs from an authenticated same-origin
 * bridge tab (the hostile page can't carry the session cookie).
 */
export const submitImport = createServerFn({ method: "POST" })
  .validator((data: SubmitImportInput) => ({
    url: String(data?.url ?? "").trim(),
    jsonld: typeof data?.jsonld === "string" ? data.jsonld : undefined,
    html: typeof data?.html === "string" ? data.html : undefined,
  }))
  .handler(async ({ data }): Promise<SubmitImportResult> => {
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    return runSubmitImport(did, householdId, data);
  });

/**
 * Fetch a cached import prefill by its id. Scoped to the caller (an import id is
 * their own attempt row), so one user can't read another's scrape.
 */
export const getImportPrefill = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => ({ id: String(data?.id ?? "") }))
  .handler(async ({ data }): Promise<ImportPrefill | null> => {
    if (!data.id) return null;
    const { activeContext } = await import("./recipe-context");
    const { getDb } = await import("#/lib/db");
    const { did } = await activeContext();
    const row = await getDb().selectFrom("recipe_import_attempt").select("parsed").where("id", "=", data.id).where("did", "=", did).executeTakeFirst();
    return (row?.parsed as ImportPrefill | null) ?? null;
  });

async function runScrape(did: string, householdId: string, url: string): Promise<ScrapeResult> {
  const started = Date.now();
  const host = hostOf(url);
  const { ulid } = await import("./household/ids");
  const attemptId = ulid();

  // Log helper — one row per attempt, best-effort (never fail the scrape on it).
  const log = async (status: string, extra: { extractor?: string | null; httpStatus?: number | null; error?: string | null; parsed?: ImportPrefill | null } = {}) => {
    try {
      const { getDb } = await import("#/lib/db");
      await getDb()
        .insertInto("recipe_import_attempt")
        .values({
          id: attemptId,
          did,
          household_id: householdId,
          url,
          host,
          status,
          extractor: extra.extractor ?? null,
          http_status: extra.httpStatus ?? null,
          error: extra.error ?? null,
          duration_ms: Date.now() - started,
          parsed: extra.parsed ? JSON.stringify(extra.parsed) : null,
          source: "scrape",
        })
        .execute();
    } catch {
      // Audit logging must never break the user-facing flow.
    }
  };

  // Basic URL shape check before doing anything expensive.
  if (!/^https?:\/\//i.test(url)) {
    await log("invalid_url");
    return { status: "invalid_url" };
  }

  // 1. Rate limit — Redis SET NX PX. On hit, a GENERIC result only (the UI must
  //    not reveal the window / retry-after; don't hand an abuser the timing).
  try {
    const { getRedis } = await import("#/lib/redis");
    const ok = await getRedis().set(`scrape:${did}`, "1", "PX", RATE_LIMIT_WINDOW_MS, "NX");
    if (ok !== "OK") {
      await log("rate_limited");
      return { status: "rate_limited" };
    }
  } catch {
    // If Redis is down, fail OPEN (allow the scrape) rather than block imports —
    // the rate limit is abuse mitigation, not a correctness gate.
  }

  // 2. Fetch (SSRF-guarded + cached) then 3. extract (pure package).
  try {
    const { fetchRecipePage } = await import("#/lib/net/recipe-page");
    const { extractRecipe } = await import("@buttery/recipe-extract");
    const page = await fetchRecipePage(url);
    const result = extractRecipe({ url, html: page.body });

    const prefill: ImportPrefill = { sourceUrl: url, recipe: result.recipe };
    if (result.ok) {
      await log("success", { extractor: result.extractor, httpStatus: page.status, parsed: prefill });
      return { status: "ok", importId: attemptId };
    }
    // Got the page but couldn't pull a recipe body → partial (manual fallback,
    // but keep whatever title/image we found so the form isn't blank).
    await log("parse_empty", { extractor: result.extractor, httpStatus: page.status, parsed: prefill });
    return { status: "partial", importId: attemptId };
  } catch (err) {
    const { SafeFetchError } = await import("#/lib/net/safe-fetch");
    if (err instanceof SafeFetchError) {
      if (err.code === "blocked") {
        await log("blocked", { error: err.message });
        return { status: "blocked", message: err.message };
      }
      if (err.code === "invalid_url") {
        await log("invalid_url", { error: err.message });
        return { status: "invalid_url" };
      }
      await log("fetch_failed", { httpStatus: err.httpStatus ?? null, error: err.message });
      return { status: "fetch_failed", message: err.message };
    }
    await log("error", { error: err instanceof Error ? err.message : String(err) });
    return { status: "fetch_failed", message: "Something went wrong reading that page." };
  }
}

/** Escape a string for safe interpolation into an HTML text node / script body. */
function escapeForScript(s: string): string {
  // Only `</` can prematurely close the wrapping <script>; neutralize it.
  return s.replace(/<\//g, "<\\/");
}

async function runSubmitImport(did: string, householdId: string, input: SubmitImportInput): Promise<SubmitImportResult> {
  const started = Date.now();
  const url = input.url;
  const host = hostOf(url);
  const { ulid } = await import("./household/ids");
  const attemptId = ulid();

  const log = async (status: string, extra: { extractor?: string | null; error?: string | null; parsed?: ImportPrefill | null } = {}) => {
    try {
      const { getDb } = await import("#/lib/db");
      await getDb()
        .insertInto("recipe_import_attempt")
        .values({
          id: attemptId,
          did,
          household_id: householdId,
          url,
          host,
          status,
          extractor: extra.extractor ?? null,
          http_status: null, // no server fetch — the browser supplied the bytes.
          error: extra.error ?? null,
          duration_ms: Date.now() - started,
          parsed: extra.parsed ? JSON.stringify(extra.parsed) : null,
          source: "bookmarklet",
        })
        .execute();
    } catch {
      // Audit logging must never break the user-facing flow.
    }
  };

  if (!/^https?:\/\//i.test(url)) {
    await log("invalid_url");
    return { status: "invalid_url" };
  }

  // Normalize whatever the bookmarklet shipped into HTML for the shared parser:
  // wrap JSON-LD in a <script> tag, else use the posted page HTML directly.
  const html = input.jsonld
    ? `<!doctype html><html><head><script type="application/ld+json">${escapeForScript(input.jsonld)}</script></head><body></body></html>`
    : (input.html ?? "");

  if (!html.trim()) {
    await log("empty");
    return { status: "empty" };
  }

  try {
    const { extractRecipe } = await import("@buttery/recipe-extract");
    const result = extractRecipe({ url, html });
    const prefill: ImportPrefill = { sourceUrl: url, recipe: result.recipe };
    if (result.ok) {
      await log("success", { extractor: result.extractor, parsed: prefill });
      return { status: "ok", importId: attemptId };
    }
    // Reached the content but couldn't pull a full body — still prefill whatever
    // we got (title/image), attribution stays locked to the URL.
    await log("parse_empty", { extractor: result.extractor, parsed: prefill });
    return { status: "partial", importId: attemptId };
  } catch (err) {
    await log("error", { error: err instanceof Error ? err.message : String(err) });
    return { status: "empty" };
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}
