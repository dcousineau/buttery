import { type Kysely, sql } from "kysely";

/**
 * Collections — named, re-orderable groups of boxed recipes. See
 * `docs/plans/2026-08-20-collections.md` §3.
 *
 * Tables (2), both household-scoped, both read/written ONLY behind
 * `assertMember` / `householdScopedQuery`:
 *   - `recipe_collection`       — the collection itself, plus its publish state
 *   - `recipe_collection_entry` — which recipes are filed in it, and in what order
 *
 * The names deliberately avoid `atproto_collection_recipe` (migration
 * 1785500000000): that one is the cron sweep's INBOUND index of
 * `exchange.recipe.recipe` records seen on the network, and has nothing to do
 * with this feature.
 *
 * Two orderings, both manual (§2.1), both dense `0..n-1` and both rewritten
 * under a `FOR UPDATE` lock on the parent scope — the `meal_plan_entry` pattern
 * (§3.6 of the planner plan). `recipe_collection.position` is household-wide and
 * **local-only, never published** (§2.10); `recipe_collection_entry.position` IS
 * the order of the `recipes` array in the published
 * `exchange.recipe.collection` record.
 *
 * FK behavior (§3):
 *   - `recipe_collection.household_id`   → `household.id`         ON DELETE CASCADE
 *   - `recipe_collection_entry.collection_id` → `recipe_collection.id` ON DELETE CASCADE
 *   - `recipe_collection_entry (household_id, recipe_id)` → `household_recipe`
 *     ON DELETE CASCADE — the `household_recipe_note` trick. It says two things
 *     at once: only a BOXED recipe can be filed, and removing a recipe from the
 *     box unfiles it from every collection in the household for free. (Only the
 *     rows go for free; `position` still needs an explicit renumber, which
 *     `removeRecipeFromHousehold` does in the same transaction — §5.)
 *
 * The publish columns are all-or-none (`num_nonnulls … in (0, 7)`): an
 * unpublished collection has none of them, a published one has all of them.
 * `record_created_at` is frozen at first publish so the record's `createdAt`
 * cannot drift on a re-put, and `published_by_did` is the DID whose stored OAuth
 * session every later re-put goes through (§2.5) — not "the owner", not "the
 * editor".
 *
 * Hard delete throughout, matching `household_recipe`: push-only v1 has nothing
 * to reconcile a tombstone against.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not track
 * the evolving `DB` interface (matches the existing migrations).
 */

const now = sql`now()`;

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // --- recipe_collection --------------------------------------------------
  await db.schema
    .createTable("recipe_collection")
    .addColumn("id", "text", (col) => col.primaryKey()) // app-minted ULID (server/household/ids.ts)
    .addColumn("household_id", "text", (col) => col.notNull().references("household.id").onDelete("cascade"))
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("description", "text") // null = none; `text` in the lexicon
    // Dense 0..n-1 per household. New collections append at the bottom (§2.1).
    .addColumn("position", "integer", (col) => col.notNull())
    .addColumn("created_by_did", "text", (col) => col.notNull()) // provenance, NOT ownership
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    // --- publish state: all seven together, or none of them ---------------
    .addColumn("published_by_did", "text") // whose PDS holds it; drives getUserRecipeClient
    .addColumn("rkey", "text") // PDS-minted TID (the lexicon's key type), parsed off the create's uri
    .addColumn("uri", "text")
    .addColumn("cid", "text") // latest known cid — the swapRecord CAS input
    .addColumn("rev", "text")
    .addColumn("published_at", "timestamptz") // FIRST publish; never bumped by a re-put
    .addColumn("record_created_at", "timestamptz") // frozen record `createdAt`
    // A re-put that failed. Never blocks a local edit (§8) — it only annotates,
    // and the next successful write clears it.
    .addColumn("record_stale", "boolean", (col) => col.notNull().defaultTo(false))
    // Lexicon limits, enforced here as well as at the zod validator and the PDS:
    // `name` maxLength 100, `text` maxLength 1000. Postgres counts characters,
    // the PDS counts bytes/graphemes — this is the cheap outer bound, not the
    // authority (§8).
    .addCheckConstraint("recipe_collection_name_check", sql`char_length(name) between 1 and 100`)
    .addCheckConstraint("recipe_collection_description_check", sql`description is null or char_length(description) <= 1000`)
    .addCheckConstraint("recipe_collection_publish_shape_check", sql`num_nonnulls(published_by_did, rkey, uri, cid, rev, published_at, record_created_at) in (0, 7)`)
    // NOTE: deliberately NO unique constraint on (household_id, name). Duplicate
    // names are legal everywhere (§8) — the inline quick-add must never fail on
    // a name collision.
    .execute();

  // The one read (`listCollections`) is this index, front to back.
  await db.schema.createIndex("recipe_collection_household_position_idx").on("recipe_collection").columns(["household_id", "position"]).execute();

  // --- recipe_collection_entry -------------------------------------------
  await db.schema
    .createTable("recipe_collection_entry")
    .addColumn("collection_id", "text", (col) => col.notNull().references("recipe_collection.id").onDelete("cascade"))
    .addColumn("household_id", "text", (col) => col.notNull())
    .addColumn("recipe_id", "text", (col) => col.notNull())
    // Dense 0..n-1 per collection. This IS the published `recipes` array order.
    .addColumn("position", "integer", (col) => col.notNull())
    .addColumn("added_by_did", "text", (col) => col.notNull()) // provenance
    .addColumn("added_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    // A recipe files into a collection at most once; filing it twice is a
    // silent no-op (`on conflict do nothing`), not an error (§8).
    .addPrimaryKeyConstraint("recipe_collection_entry_pkey", ["collection_id", "recipe_id"])
    // The entry references the BOX row, not `recipe` directly — see the header.
    .addForeignKeyConstraint("recipe_collection_entry_box_fkey", ["household_id", "recipe_id"], "household_recipe", ["household_id", "recipe_id"], (fk) => fk.onDelete("cascade"))
    .execute();

  // Read order within a collection, and the `FOR UPDATE` lock's scan.
  await db.schema.createIndex("recipe_collection_entry_position_idx").on("recipe_collection_entry").columns(["collection_id", "position"]).execute();

  // "Which collections hold this recipe?" — the chips on a recipe, and the
  // affected-collection sweep `removeRecipeFromHousehold` runs before the
  // cascade takes the rows away. The PK leads with `collection_id`, so this
  // probe needs its own index.
  await db.schema.createIndex("recipe_collection_entry_recipe_idx").on("recipe_collection_entry").columns(["household_id", "recipe_id"]).execute();
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  // Reverse order. The entries reference the collection, so they drop first.
  await db.schema.dropTable("recipe_collection_entry").ifExists().execute();
  await db.schema.dropTable("recipe_collection").ifExists().execute();
}
