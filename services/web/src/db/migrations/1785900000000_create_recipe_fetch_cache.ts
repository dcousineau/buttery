import { type Kysely, sql } from "kysely";

/**
 * Raw fetched-HTML cache (docs/plans/2026-08-02-create-recipes.md, Phase B).
 * Every successful scrape fetch stores the page's raw HTML here, keyed by the
 * normalized URL. Two payoffs:
 *
 *   1. Re-imports and retries don't re-hit the origin (politeness + speed).
 *   2. When the extractor improves or a new per-host adapter lands
 *      (packages/recipe-extract/src/sites/*), we can RE-PARSE cached pages
 *      offline instead of re-crawling — the raw bytes are the ground truth.
 *
 * Separate from `recipe_import_attempt` on purpose: that table logs every try
 * (including failures) as an audit trail; this one holds the heavy raw body only
 * for fetches that succeeded. Bodies are size-capped upstream by safe-fetch.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not track
 * the evolving `DB` interface (matches the existing migrations).
 */

const now = sql`now()`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("recipe_fetch_cache")
    // Normalized request URL (fragment stripped) — the cache key.
    .addColumn("url", "text", (col) => col.primaryKey())
    // Bare host for rollups / optional per-host cache invalidation.
    .addColumn("host", "text")
    // Where the fetch actually landed after following redirects.
    .addColumn("final_url", "text")
    .addColumn("http_status", "integer")
    .addColumn("content_type", "text")
    // The raw HTML. Postgres text is fine; safe-fetch caps the size (~3 MB).
    .addColumn("body", "text", (col) => col.notNull())
    .addColumn("byte_size", "integer")
    .addColumn("fetched_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .execute();

  // Freshness sweeps / host invalidation.
  await db.schema.createIndex("recipe_fetch_cache_fetched_at_idx").on("recipe_fetch_cache").column("fetched_at").execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("recipe_fetch_cache").ifExists().execute();
}
