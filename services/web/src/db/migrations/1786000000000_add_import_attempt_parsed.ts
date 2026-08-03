import { type Kysely, sql } from "kysely";

/**
 * Cache the PARSED import prefill alongside the fetch attempt (Phase B, user
 * request). On a successful scrape the extracted, lexicon-shaped prefill is
 * stored here and the attempt's `id` is handed to the client as an opaque import
 * id. The create form then fetches the prefill by id (server fn getImportPrefill)
 * instead of carrying the whole payload in the URL.
 *
 * Storing the parse next to the raw fetch (recipe_fetch_cache holds the HTML;
 * this holds the derived record) means a re-open by id is a cheap DB read, and a
 * future re-parse can compare against what we produced at import time.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("recipe_import_attempt").addColumn("parsed", "jsonb").execute();
  void sql;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("recipe_import_attempt").dropColumn("parsed").execute();
}
