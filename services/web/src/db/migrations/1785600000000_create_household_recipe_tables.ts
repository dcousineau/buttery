import { type Kysely, sql } from "kysely";

/**
 * The household "recipe box" — the sparse join that links an existing rendered
 * `recipe` into a household's shelf, plus one shared private note per boxed
 * recipe. See `docs/plans/03-household-recipe-collection.md` §3.
 *
 * Tables (2), both Buttery-PRIVATE (never written to any PDS), both descending
 * from `household`, both read/written ONLY behind `assertMember` /
 * `householdScopedQuery`:
 *   - `household_recipe`      — the sparse join keyed on `recipe.id` (the box)
 *   - `household_recipe_note` — one shared private note per boxed recipe
 *
 * WHY a join keyed on `recipe.id` (not a `(household_id, uri)` snapshot): the
 * rendered `recipe` layer (migration 1785300000000) already IS the durable local
 * snapshot, keyed on the stable ULID `recipe.id`. The box is a pointer into it;
 * the "survive source deletion" requirement is met by keeping the rendered row
 * alive — see the RESTRICT FK below + the cron save-guard (§9.1, render.ts).
 *
 * FK behavior (§3):
 *   - `household_recipe.household_id` → `household.id`  ON DELETE CASCADE
 *   - `household_recipe.recipe_id`    → `recipe.id`     ON DELETE RESTRICT
 *     (a saved recipe's rendered row may not be deleted out from under the box;
 *      the cron guard stops it ever *attempting* to — this is the backstop.)
 *   - `household_recipe_note (household_id, recipe_id)` → `household_recipe`
 *     ON DELETE CASCADE (removing a recipe from the box drops its note).
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not track
 * the evolving `DB` interface (matches the existing migrations).
 */

const now = sql`now()`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // --- household_recipe (the box) ---------------------------------------
  await db.schema
    .createTable("household_recipe")
    .addColumn("household_id", "text", (col) => col.notNull().references("household.id").onDelete("cascade"))
    // RESTRICT: the rendered row is the household's durable cache; nothing may
    // delete it while it is boxed. The cron save-guard (render.ts) prevents the
    // sweep from even attempting it; this FK is the safety net for any other path.
    .addColumn("recipe_id", "text", (col) => col.notNull().references("recipe.id").onDelete("restrict"))
    .addColumn("added_by_did", "text", (col) => col.notNull()) // from session; provenance only
    .addColumn("added_at", "timestamptz", (col) => col.notNull().defaultTo(now)) // drives "Recent" sort
    .addColumn("favorite", "boolean", (col) => col.notNull().defaultTo(false)) // household-shared (§4)
    .addColumn("favorited_at", "timestamptz") // set when favorited; for a future sort
    // A recipe appears at most once per box; add is idempotent (on conflict do nothing).
    .addPrimaryKeyConstraint("household_recipe_pkey", ["household_id", "recipe_id"])
    .execute();

  // The RESTRICT FK check + "is this recipe in any box" (the cron guard's
  // NOT EXISTS) both probe by recipe_id; the PK's leading column is household_id,
  // so an explicit recipe_id index keeps those cheap.
  await db.schema.createIndex("household_recipe_recipe_id_idx").on("household_recipe").column("recipe_id").execute();

  // --- household_recipe_note (shared private note) ----------------------
  await db.schema
    .createTable("household_recipe_note")
    .addColumn("household_id", "text", (col) => col.notNull())
    .addColumn("recipe_id", "text", (col) => col.notNull())
    // Last editor (shared note → provenance, not ownership).
    .addColumn("author_did", "text", (col) => col.notNull())
    .addColumn("body", "text", (col) => col.notNull()) // empty body ⇒ row deleted, never stored blank
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(now)) // bumped on edit
    .addPrimaryKeyConstraint("household_recipe_note_pkey", ["household_id", "recipe_id"])
    // The note references the JOIN row, not `recipe` directly, so removing a
    // recipe from the box cascades its note away.
    .addForeignKeyConstraint("household_recipe_note_box_fkey", ["household_id", "recipe_id"], "household_recipe", ["household_id", "recipe_id"], (fk) => fk.onDelete("cascade"))
    .execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  // Reverse order. The note references the box, so it drops first.
  await db.schema.dropTable("household_recipe_note").ifExists().execute();
  await db.schema.dropTable("household_recipe").ifExists().execute();
}
