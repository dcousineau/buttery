import { type Kysely, sql } from "kysely";

/**
 * Buttery-only recipe metadata + import sessions. See
 * `docs/plans/2026-08-09-paprika-import.md` §5.1–§5.3.
 *
 * Three tables, all generic — they know about recipes, households and imports,
 * and nothing about Paprika (or any other importer):
 *   - `recipe_meta`            — namespaced key/value about the recipe itself
 *   - `household_recipe_meta`  — namespaced key/value per (household, recipe)
 *   - `recipe_import_session`  — one row per batch-import run
 *
 * ── NEVER PUBLISHED (§2.3) ────────────────────────────────────────────────
 * `recipe_meta` and `household_recipe_meta` are read by Buttery and by NOTHING
 * ELSE. Nothing in `lib/atproto/recipe-writes` or `services/atproto-cron-sync`
 * may read them, and no value in either table may ever reach an
 * `exchange.recipe.recipe` record. This is a review rule; a test asserts the
 * published record shape is unchanged by the presence of sidecar rows.
 *
 * ── KEY/VALUE IS A VELOCITY CHOICE, NOT AN ENDORSEMENT (§5.5) ─────────────
 * Namespaced key/value over `jsonb` was picked to move fast, not because it is
 * the right long-term shape. It has real costs: no type safety, a
 * `to_jsonb($1::text)` at every call site, and no FK on values. The expectation
 * is that any namespace which proves durable GRADUATES to typed columns or a
 * purpose-built table. Do not read the existence of these tables as permission
 * to model the next feature this way by default.
 *
 * ── WHY THE GENERIC INDEXES OMIT `value` (D37, §5.1/§5.2) ─────────────────
 * A B-tree index entry is capped at ~2704 bytes (a third of an 8 kB page),
 * while the commit boundary (§7.2) permits an 8 kB serialized metadata value.
 * Indexing `value` generically would therefore make an in-spec write fail with
 * `index row size … exceeds btree maximum` at INSERT time, for no reason other
 * than that the row happens to be indexed. It bites hardest on
 * `household_recipe_meta`, which is where the importer's `raw` blob lands.
 * So the generic indexes are `(ns, key)` / `(household_id, ns, key)` prefixes
 * only, and the two lookups that genuinely need to search BY VALUE — the dedupe
 * keys and the import session id, both short and bounded — get their own narrow
 * partial expression indexes. Any future namespace that needs a value lookup
 * adds its own partial index and owns its own size bound.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not
 * track the evolving `DB` interface (matches the existing migrations).
 */

const now = sql`now()`;

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // --- recipe_meta (global; facts true of the recipe itself) -------------
  // Phase 1 writes exactly two keys: ('dedupe','source_url_key') and
  // ('dedupe','content_fp') — see §6.
  await db.schema
    .createTable("recipe_meta")
    .addColumn("recipe_id", "text", (col) => col.notNull().references("recipe.id").onDelete("cascade"))
    .addColumn("ns", "text", (col) => col.notNull()) // "dedupe", "llm.enhance", …
    .addColumn("key", "text", (col) => col.notNull())
    .addColumn("value", "jsonb", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addPrimaryKeyConstraint("recipe_meta_pkey", ["recipe_id", "ns", "key"])
    .execute();

  // Generic prefix scan. Deliberately WITHOUT `value` — see D37 in the header.
  await db.schema.createIndex("recipe_meta_lookup").on("recipe_meta").columns(["ns", "key"]).execute();

  // The one by-value lookup: "does any recipe already have this dedupe key?".
  // Narrow and partial because dedupe values are short, bounded strings.
  await sql`
    create index recipe_meta_dedupe
      on recipe_meta ((value #>> '{}'))
      where ns = 'dedupe'
  `.execute(db);

  // --- household_recipe_meta (per household+recipe) ----------------------
  // ALL import bookkeeping lives here: how a recipe arrived in THIS box is a
  // fact about the household's import, not about the recipe (§2.2, §5.2).
  // One shared namespace for every importer — `ns='import'` with the importer
  // named in a key, never `ns='import.paprika'` (D32).
  await db.schema
    .createTable("household_recipe_meta")
    .addColumn("household_id", "text", (col) => col.notNull().references("household.id").onDelete("cascade"))
    .addColumn("recipe_id", "text", (col) => col.notNull().references("recipe.id").onDelete("cascade"))
    .addColumn("ns", "text", (col) => col.notNull()) // "import", …
    .addColumn("key", "text", (col) => col.notNull())
    .addColumn("value", "jsonb", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addPrimaryKeyConstraint("household_recipe_meta_pkey", ["household_id", "recipe_id", "ns", "key"])
    .execute();

  // Generic prefix scan. Deliberately WITHOUT `value` — see D37 in the header;
  // this is the table whose values actually approach the 8 kB cap (`raw`).
  await db.schema.createIndex("household_recipe_meta_lookup").on("household_recipe_meta").columns(["household_id", "ns", "key"]).execute();

  // The one by-value lookup the pipeline performs: "every recipe from session
  // X", for the finalize counters (§7.7) and the future undo pass (§17).
  await sql`
    create index household_recipe_meta_session
      on household_recipe_meta ((value #>> '{}'))
      where ns = 'import' and key = 'session_id'
  `.execute(db);

  // --- recipe_import_session (one row per batch-import run) --------------
  await db.schema
    .createTable("recipe_import_session")
    .addColumn("id", "text", (col) => col.primaryKey()) // app-minted ULID
    .addColumn("household_id", "text", (col) => col.notNull().references("household.id"))
    .addColumn("did", "text", (col) => col.notNull()) // who started it; provenance
    // `importer` holds a `RecipeImporter.id` (§2.5) — phase 1: 'paprika' — and
    // NOTHING ELSE (D31/§5.3). It is NOT the same thing as
    // `recipe_import_attempt.source`, which already exists and means the
    // TRANSPORT a single scraped recipe arrived over ('scrape' | 'bookmarklet').
    // The two value spaces must never be confused or merged: an importer id
    // answers "which app's export is this", a transport answers "how did these
    // bytes reach us". 'scrape' and 'bookmarklet' are NOT legal values here and
    // never will be.
    //
    // Free text (following the sibling table's precedent) so a new importer
    // needs no migration; the server function that opens a session validates
    // against a Zod enum derived from the importer registry, so an unknown id
    // is a 400 and not a row.
    //
    // NO DEFAULT, on purpose: a default silently mislabels the second
    // importer's sessions the first time someone forgets to pass one.
    .addColumn("importer", "text", (col) => col.notNull())
    // parsing → reviewing → committing → complete, plus terminal failed /
    // abandoned. A session left in `committing` is what makes
    // resume-after-disconnect possible (§7.5).
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("file_name", "text") // what the user handed us, e.g. "My Recipes"
    .addColumn("total_count", "integer", (col) => col.notNull().defaultTo(0))
    // Counters are DERIVED at finalize, never incremented per chunk (D35).
    .addColumn("imported_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("skipped_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("failed_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("started_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("finished_at", "timestamptz") // null while in flight
    .execute();

  // "My import history", newest first. No cleanup job in phase 1; stale
  // sessions are harmless rows.
  await sql`
    create index recipe_import_session_household
      on recipe_import_session (household_id, started_at desc)
  `.execute(db);
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("recipe_import_session").ifExists().execute();
  await db.schema.dropTable("household_recipe_meta").ifExists().execute();
  await db.schema.dropTable("recipe_meta").ifExists().execute();
}
