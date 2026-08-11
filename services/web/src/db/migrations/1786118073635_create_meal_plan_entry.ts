import { type Kysely, sql } from "kysely";

/**
 * `meal_plan_entry` — the ONE table behind the weekly meal plan. See
 * `docs/plans/2026-08-06-meal-planner.md` §3.2–§3.6.
 *
 * One polymorphic table with a `kind` discriminator (`recipe` | `note`, and
 * later `collection` | `menu`) rather than a table per kind. Ordering is the
 * reason: entries of different kinds interleave inside a slot, so a
 * table-per-kind design would have to synthesize a union view and reconcile two
 * `position` sequences on every move. One table = one sequence, one move
 * statement, one soft-delete path.
 *
 * Text CHECKs over Postgres enums: adding `collection`/`menu` later is a
 * one-line constraint swap, not an enum migration, and it matches how
 * `recipe.origin` and `household_member.role` are already modelled.
 *
 * `plan_date` is a Postgres `date`, never a timestamp (§2.3): an entry is
 * planned for `2026-08-12`, not for an instant, so DST can never shift a meal.
 * The household timezone is used only for "today", the cook-mode prompt, and
 * `.ics` event times.
 *
 * FK behavior:
 *   - `household_id` → `household.id` ON DELETE CASCADE
 *   - `recipe_id`    → `recipe.id`    ON DELETE RESTRICT (D3/§3.4): the entry
 *     points at the rendered `recipe` row — the durable local snapshot — so
 *     removing the recipe from every box does NOT break the plan. RESTRICT
 *     mirrors `household_recipe`; the cron sweep gains a matching NOT EXISTS
 *     guard (§7.3) so the sweep never *attempts* such a delete.
 *
 * Buttery-PRIVATE forever (D7): no lexicon, no PDS record. Portability comes
 * via calendar export instead.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not
 * track the evolving `DB` interface (matches the existing migrations).
 */

const now = sql`now()`;

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("meal_plan_entry")
    .addColumn("id", "text", (col) => col.primaryKey()) // app-minted ULID (server/household/ids.ts)
    .addColumn("household_id", "text", (col) => col.notNull().references("household.id").onDelete("cascade"))
    .addColumn("plan_date", "date", (col) => col.notNull()) // calendar date, never an instant
    .addColumn("slot", "text", (col) => col.notNull()) // breakfast|lunch|dinner|snack
    .addColumn("kind", "text", (col) => col.notNull()) // recipe|note (future: collection|menu)
    // Dense 0..n-1 within (household_id, plan_date, slot). v1 only ever appends
    // (D14 — the design has no within-slot reorder affordance), but the column
    // is what makes read order stable and what a future reorder splices into.
    .addColumn("position", "integer", (col) => col.notNull())
    .addColumn("recipe_id", "text", (col) => col.references("recipe.id").onDelete("restrict"))
    .addColumn("body", "text") // note text, ≤ 2000 chars (enforced app-side)
    .addColumn("cooked_at", "timestamptz")
    .addColumn("cooked_by_did", "text") // provenance ("cooked by @sam"), NOT ownership
    .addColumn("created_by_did", "text", (col) => col.notNull()) // provenance ("added by @dan")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    // Soft delete (D6). Retained rows keep the recipe FK alive on purpose — a
    // deleted-then-restored plan must not have lost its recipe.
    .addColumn("deleted_at", "timestamptz")
    .addCheckConstraint("meal_plan_entry_slot_check", sql`slot in ('breakfast','lunch','dinner','snack')`)
    .addCheckConstraint("meal_plan_entry_kind_check", sql`kind in ('recipe','note')`)
    // The two kind/payload pairings. Written as `kind <> X or (…)` so adding a
    // third kind later leaves both of these trivially satisfied.
    .addCheckConstraint("meal_plan_entry_recipe_shape_check", sql`kind <> 'recipe' or (recipe_id is not null and body is null)`)
    .addCheckConstraint("meal_plan_entry_note_shape_check", sql`kind <> 'note' or (body is not null and recipe_id is null)`)
    // NOTE: deliberately NO uniqueness on (household_id, plan_date, slot,
    // recipe_id) — the same recipe may appear twice in a slot on purpose
    // (double batch, two protein variants). Decision D4.
    .execute();

  // The week read is a single range scan over live rows.
  await sql`
    create index meal_plan_entry_week_idx
      on meal_plan_entry (household_id, plan_date)
      where deleted_at is null
  `.execute(db);

  // Makes the ON DELETE RESTRICT check, the cron sweep guard (§7.3) and
  // "is this recipe planned?" (§7.2) cheap. NOT filtered on `deleted_at`:
  // soft-deleted rows still hold the FK reference, so the guard must see them.
  await db.schema.createIndex("meal_plan_entry_recipe_id_idx").on("meal_plan_entry").column("recipe_id").execute();
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("meal_plan_entry").ifExists().execute();
}
