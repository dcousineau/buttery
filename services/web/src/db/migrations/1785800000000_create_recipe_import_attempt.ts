import { type Kysely, sql } from "kysely";

/**
 * Recipe import/scrape attempt log (docs/plans/2026-08-02-create-recipes.md,
 * Phase B). Every server-side scrape attempt writes one row here — success or
 * failure — so we can:
 *
 *   1. Track failures per host and see which sites block Buttery / return no
 *      structured data. This drives where a bespoke per-host extractor is worth
 *      building (packages/recipe-extract/src/sites/*).
 *   2. Observe which extractor path succeeded (jsonld / microdata / heuristics /
 *      a site adapter) to measure extraction quality over time.
 *
 * This is a plain append-only audit table — no FK to `recipe` (an attempt may
 * never become a recipe, and a recipe may be created without it). The scrape is
 * a regular server fn today; when it becomes a job-triggered worker later, the
 * worker writes the same row (the shape is transport-agnostic on purpose).
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not track
 * the evolving `DB` interface (matches the existing migrations).
 */

const now = sql`now()`;

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("recipe_import_attempt")
    .addColumn("id", "text", (col) => col.primaryKey())
    // Who attempted it (atproto DID). Kept even if the account is later removed —
    // this is an operational audit trail, not user-owned content.
    .addColumn("did", "text", (col) => col.notNull())
    // Active household at attempt time, if any (context, not ownership).
    .addColumn("household_id", "text")
    // The raw URL the user asked us to import.
    .addColumn("url", "text", (col) => col.notNull())
    // Normalized bare hostname ("www.foo.com" → "foo.com") for per-site rollups.
    .addColumn("host", "text")
    // Outcome. One of: success | rate_limited | blocked | fetch_failed |
    // parse_empty | error. Kept as free text (not an enum) so new outcomes don't
    // need a migration; the server fn owns the vocabulary.
    .addColumn("status", "text", (col) => col.notNull())
    // Which extraction path produced the result on success:
    // 'jsonld' | 'microdata' | 'heuristics' | 'site:<host>'. Null on failure.
    .addColumn("extractor", "text")
    // HTTP status of the page fetch, when we got that far.
    .addColumn("http_status", "integer")
    // Short failure reason (safe-fetch rejection, parse-empty note, error message).
    .addColumn("error", "text")
    // Wall-clock of the whole attempt, for spotting slow/hostile sites.
    .addColumn("duration_ms", "integer")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .execute();

  // Per-host failure rollups ("which sites fail most" → build an adapter).
  await db.schema.createIndex("recipe_import_attempt_host_status_idx").on("recipe_import_attempt").columns(["host", "status"]).execute();
  // Per-account recent history (abuse review, support answers).
  await db.schema.createIndex("recipe_import_attempt_did_created_idx").on("recipe_import_attempt").columns(["did", "created_at"]).execute();
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("recipe_import_attempt").ifExists().execute();
}
