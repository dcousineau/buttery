import { type Kysely, sql } from "kysely";

/**
 * The consolidated household grocery list (grocery-list plan §6).
 *
 * Two tables, one logical unit, one migration: the household's items and the
 * contributions that produced each one. They are created together because
 * neither means anything alone and the FK runs straight through.
 *
 * ── Why there is no `grocery_list` table ────────────────────────────────────
 *
 * There is exactly one running list per household (plan D1) — not per week, not
 * named, not ephemeral. A table whose every row is `(id, household_id)` in
 * one-to-one correspondence with `household` stores nothing that
 * `grocery_item.household_id` does not already say. It bought a `list_id` FK, a
 * uniqueness index to enforce the one-to-one, a create-on-first-use dance with a
 * race to lose, and an `updated_at` nobody read. `household_id` IS the list
 * identity, so every index and every WHERE keys on it directly.
 *
 * ── Why quantities live here and not on `recipe_ingredient` ──────────────────
 *
 * `recipe_ingredient` is `(recipe_id, ordinal, text)` and stays that way (plan
 * D2). Ingredients are free text; parsing them is lossy, and a lossy parse
 * written back onto the recipe would corrupt the thing the household actually
 * typed. So the parse happens at add-to-list time and its results land on these
 * rows, where being wrong costs one editable line on a shopping list rather than
 * the recipe itself.
 *
 * ── Why `aisle` is denormalized onto the row ─────────────────────────────────
 *
 * The aisle is resolved from the generated food lexicon at insert time and
 * copied here. Regenerating that lexicon from a newer Open Food Facts taxonomy
 * must never silently reshuffle a list somebody is holding in a store.
 *
 * ── Why `raw_text` is snapshotted ───────────────────────────────────────────
 *
 * `docs/research/05-private-vs-public-data.md:196` asked for the shopping list
 * to survive its source going away. `grocery_item_source.raw_text` is that: the
 * verbatim ingredient line, so a list never depends on re-reading a recipe that
 * may have been edited, unboxed, or deleted since.
 *
 * ── The live-row unique index (plan D10 / D11) ──────────────────────────────
 *
 * Checked items are never deleted. `checked_at` is set, the row dims, and it
 * leaves the default view once it is older than the TTL; the row itself stays as
 * history. That makes uniqueness a property of LIVE rows only, which is what the
 * partial index expresses. Re-adding a food whose row has been retired therefore
 * creates a NEW row rather than reviving and re-totalling an old one — you
 * bought that chicken already.
 *
 * ── `cleared_at`, the soft delete ───────────────────────────────────────────
 *
 * The two sweeps on the list menu — "clear purchased" and "clear all" — stamp
 * `cleared_at` instead of deleting. Same promise as `checked_at`: the row leaves
 * the list and stays as history, so a trip you swept at the till is still
 * answerable later. It is a SEPARATE column rather than a reuse of `checked_at`
 * because "I bought this" and "get this off my list" are different facts, and
 * clearing an unchecked row must not claim you bought it.
 *
 * A cleared row is out of the live index too, so clearing frees the identity and
 * a re-added food starts a fresh row rather than resurrecting a swept one. Only
 * "delete everything" is a real DELETE, and it is the only thing that reclaims
 * cleared rows.
 *
 * There is no `cleared_by_did`. `checked_by_did` earns its keep by rendering
 * ("got by @sam"); nothing displays who swept, and a column nobody reads is the
 * kind this schema already went out of its way to remove.
 *
 * ── `merge_unit`, which §6's sketch did not have ────────────────────────────
 *
 * D5 forbids merging across unit dimensions, and the sketched index keys on
 * `unit_dim` alone. That is not quite enough. `cup` and `tbsp` are both volume
 * and both convert to millilitres, so summing them is honest — but `clove` and
 * `can` are both `count` and convert to nothing, so keying on the dimension
 * alone would force "2 cans tomatoes" and "3 tomatoes" into one row reading 5.
 * `merge_unit` is null for a unit that converts freely and the unit itself for
 * one that does not, so it only ever splits rows D5 already wanted split;
 * nothing that used to merge stops merging. See `src/lib/grocery/units.ts`.
 *
 * Aisle values are checked against a constraint mirroring `aisles.ts`, the same
 * pattern `meal_plan_entry_slot_check` uses — a text column plus a CHECK, never
 * a Postgres enum, so adding an aisle is a migration and not a type surgery.
 */

const now = sql`now()`;

/** Mirrors `AISLES` in `services/web/src/lib/grocery/aisles.ts`. */
const AISLES = sql`aisle in ('produce','meat_seafood','dairy_eggs','bakery','deli','frozen','canned_jarred','dry_goods','pantry','spices','baking','beverages','snacks','other')`;

/** Mirrors `UnitDim` in `services/web/src/lib/grocery/units.ts`. */
const UNIT_DIMS = sql`unit_dim is null or unit_dim in ('volume','mass','count')`;

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // --- grocery_item -------------------------------------------------------
  await db.schema
    .createTable("grocery_item")
    .addColumn("id", "text", (col) => col.primaryKey()) // app-minted ULID
    // The household IS the list (see the header). Every write re-asserts this in
    // its WHERE without a join, the same way `meal_plan_entry` does.
    .addColumn("household_id", "text", (col) => col.notNull().references("household.id").onDelete("cascade"))
    .addColumn("food_slug", "text") // Open Food Facts id; null when unmatched
    .addColumn("name_norm", "text", (col) => col.notNull()) // identity fallback + display key
    .addColumn("display_name", "text", (col) => col.notNull()) // what the user sees; editable
    .addColumn("aisle", "text", (col) => col.notNull()) // resolved at insert, denormalized
    .addColumn("quantity", "numeric") // base units: ml, g, or a bare count
    .addColumn("quantity_max", "numeric") // upper bound when a source gave a range
    .addColumn("unit", "text") // canonical unit id; anchors how the total renders
    .addColumn("unit_dim", "text") // volume|mass|count
    .addColumn("merge_unit", "text") // pins a discrete row to one unit; see above
    .addColumn("is_manual", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("checked_at", "timestamptz")
    .addColumn("checked_by_did", "text") // provenance ("got by @sam"), NOT ownership
    .addColumn("cleared_at", "timestamptz") // soft delete: off the list, kept as history
    .addColumn("created_by_did", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addCheckConstraint("grocery_item_aisle_check", AISLES)
    .addCheckConstraint("grocery_item_unit_dim_check", UNIT_DIMS)
    .execute();

  // D11: identity is unique only among LIVE rows, so a retired row never
  // captures a new add and never revives. Raw SQL rather than the builder
  // because this is a partial unique index over expressions.
  await sql`
    create unique index grocery_item_live_identity_key
      on grocery_item (household_id, coalesce(food_slug, name_norm), coalesce(unit_dim, ''), coalesce(merge_unit, ''))
      where checked_at is null and cleared_at is null
  `.execute(db);

  // The list read is a single scan of one household's live-or-recently-checked
  // rows in canonical aisle order. Named for what it now keys on: there is no
  // list to be an index "on".
  await db.schema.createIndex("grocery_item_household_aisle_idx").on("grocery_item").columns(["household_id", "aisle"]).execute();

  // --- grocery_item_source ------------------------------------------------
  // One row per contributing ingredient line. `recipe_id` is nullable and set
  // null on delete rather than restricting: a manual item has no recipe, and a
  // recipe leaving the box must not take the shopping list down with it —
  // `raw_text` is what the row actually reads from.
  await db.schema
    .createTable("grocery_item_source")
    .addColumn("id", "text", (col) => col.primaryKey()) // app-minted ULID
    .addColumn("item_id", "text", (col) => col.notNull().references("grocery_item.id").onDelete("cascade"))
    .addColumn("recipe_id", "text", (col) => col.references("recipe.id").onDelete("set null"))
    .addColumn("plan_entry_id", "text", (col) => col.references("meal_plan_entry.id").onDelete("set null"))
    .addColumn("scale", "numeric", (col) => col.notNull().defaultTo(1))
    .addColumn("raw_text", "text", (col) => col.notNull()) // verbatim ingredient line, snapshotted
    .addColumn("quantity_base", "numeric") // this source's contribution, base units
    .addColumn("added_by_did", "text", (col) => col.notNull())
    .addColumn("added_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .execute();

  await db.schema.createIndex("grocery_item_source_item_idx").on("grocery_item_source").column("item_id").execute();
  await db.schema.createIndex("grocery_item_source_recipe_idx").on("grocery_item_source").column("recipe_id").execute();
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("grocery_item_source").ifExists().execute();
  await db.schema.dropTable("grocery_item").ifExists().execute();
}
