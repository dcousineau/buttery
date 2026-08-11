import { type Kysely, sql } from "kysely";

/**
 * Record HOW an import attempt reached us (Phase C, docs/plans/2026-08-02-create-recipes.md).
 * Two transports now converge on `recipe_import_attempt`:
 *
 *   - 'scrape'      → server-side fetch (Phase B `scrapeRecipe`): we pulled the
 *                     page ourselves through the SSRF-guarded fetch + cache.
 *   - 'bookmarklet' → the browser bookmarklet (Phase C `submitImport`): the user's
 *                     own browser shipped us JSON-LD or raw HTML from a hostile page
 *                     we could never fetch server-side.
 *
 * Keeping the two apart in the audit log matters for prioritizing per-host
 * adapters: a host that only ever succeeds via the bookmarklet is a host that
 * blocks our server fetch, a different signal than a host whose structured data
 * is simply poor. Free text (like `status`) so new transports need no migration;
 * defaults to 'scrape' so existing rows keep their meaning.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time.
 */

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("recipe_import_attempt")
    .addColumn("source", "text", (col) => col.notNull().defaultTo("scrape"))
    .execute();
  void sql;
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("recipe_import_attempt").dropColumn("source").execute();
}
