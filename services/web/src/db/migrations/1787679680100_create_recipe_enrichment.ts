import { type Kysely, sql } from "kysely";

/**
 * Recipe enrichment — derived, per-recipe facts (allergens, diet
 * compatibility, and a nutrition seam) that neither sync nor local authoring
 * can be trusted to supply. See `docs/plans/2026-08-20-recipe-enrichment.md`
 * §3.
 *
 * This is purely a Buttery-internal enhancement: nothing here is ever written
 * into an `exchange.recipe.recipe` record or published to a PDS (§1), and
 * this pipeline never writes `recipe.suitable_for_diet`, `recipe.calories` or
 * the `*_content` columns (D1) — those are what the author declared, this is
 * what the rules derived, and a disagreement between the two is data, not a
 * bug to paper over.
 *
 * Tables (2):
 *   - `recipe_enrichment`       — one row per recipe: status + the nutrition
 *                                  seam (§13, phase 2 — every nutrition column
 *                                  stays null in v1; they exist now purely so
 *                                  the estimator lands migration-free later).
 *   - `recipe_enrichment_label` — one row per (recipe, dimension, slug): the
 *                                  actual verdicts.
 *
 * FK behavior (D11): BOTH tables are `recipe_id … references recipe(id) on
 * delete cascade`, unlike `household_recipe` / `meal_plan_entry`, which are
 * `ON DELETE RESTRICT` (see 1785600000000 and the meal-planner migration) and
 * cost `render.ts` two explicit save-guards (`sweepDid`, ~L337-351) precisely
 * *because* they are durable, user-facing state that must not silently
 * vanish out from under a household. A derived enrichment row has no such
 * claim — it is disposable, fully reconstructible from the recipe's own
 * ingredients by re-running `enrich`, and a third RESTRICT guard clause in
 * `render.ts` would exist only to protect a cache. CASCADE lets a recipe
 * delete take its enrichment with it for free.
 *
 * `recipe_enrichment_label` also cascades on its composite FK to
 * `recipe_vocab (dimension, slug)` — dropping a vocab slug (never expected in
 * practice; `recipe_vocab` rows are additive) takes any labels filed under it
 * rather than leaving them orphaned.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not
 * track the evolving `DB` interface (matches the existing migrations).
 */

const now = sql`now()`;

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // --- recipe_enrichment ---------------------------------------------------
  await db.schema
    .createTable("recipe_enrichment")
    .addColumn("recipe_id", "text", (col) => col.primaryKey().references("recipe.id").onDelete("cascade")) // CASCADE — see header (D11)
    .addColumn("status", "text", (col) => col.notNull().defaultTo("stale")) // stale | ok | error — the whole trigger protocol (§3.1)
    .addColumn("classifier_version", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("input_hash", "text") // sha256 of contentFingerprint(name, ingredients) — D10
    .addColumn("enriched_at", "timestamptz")
    .addColumn("error", "text") // the message, not a stack — atproto_sync_run lesson: a failure that writes nothing is a failure nobody can see
    // --- phase 2 nutrition (§13). Written by nothing in v1; every column
    // below stays null until the USDA FDC ingestion lands as a *separate*,
    // migration-free change. Open Food Facts (§4) has no per-ingredient
    // nutrition data, so these columns cannot be filled by this pipeline —
    // they exist now only so phase 2 never needs a schema change.
    .addColumn("nutrition_method", "text") // null | 'usda-fdc' | 'llm'
    .addColumn("servings", "numeric")
    .addColumn("calories_per_serving", "integer")
    .addColumn("fat_g", "numeric")
    .addColumn("protein_g", "numeric")
    .addColumn("carbohydrate_g", "numeric")
    .addColumn("fiber_g", "numeric")
    .addColumn("sugar_g", "numeric")
    .addColumn("sodium_mg", "numeric")
    .addColumn("nutrition_confidence", "numeric")
    .execute();

  // The backfill claim query (§7.2): rows that are missing, stale, or behind
  // the current classifier_version.
  await db.schema.createIndex("recipe_enrichment_status_version_idx").on("recipe_enrichment").columns(["status", "classifier_version"]).execute();

  // --- recipe_enrichment_label ---------------------------------------------
  await db.schema
    .createTable("recipe_enrichment_label")
    .addColumn("recipe_id", "text", (col) => col.notNull().references("recipe.id").onDelete("cascade")) // CASCADE — see header (D11)
    .addColumn("dimension", "text", (col) => col.notNull()) // 'diet' | 'allergen'
    .addColumn("slug", "text", (col) => col.notNull())
    .addColumn("verdict", "text", (col) => col.notNull())
    .addColumn("confidence", "numeric", (col) => col.notNull()) // 0..1
    // Per-label, not per-row (§3.2): an LLM classifier can later overwrite one
    // recipe's allergen/sesame while rules keep owning the rest.
    .addColumn("method", "text", (col) => col.notNull()) // 'rules@1'; later 'llm:claude-…'
    .addColumn("evidence", "jsonb") // which lines and food slugs fired, and which rule — what makes a wrong verdict diagnosable instead of mysterious
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addPrimaryKeyConstraint("recipe_enrichment_label_pkey", ["recipe_id", "dimension", "slug"])
    .addForeignKeyConstraint("recipe_enrichment_label_vocab_fkey", ["dimension", "slug"], "recipe_vocab", ["dimension", "slug"], (fk) => fk.onDelete("cascade"))
    // Verdict vocabulary differs per dimension — one constraint enforces both (§3.2, verbatim).
    .addCheckConstraint(
      "recipe_enrichment_label_verdict_check",
      sql`(
        (dimension = 'allergen' and verdict in ('contains','may_contain','not_detected','unknown'))
        or (dimension = 'diet' and verdict in ('excluded','likely','unknown'))
      )`,
    )
    .execute();

  // `not_detected` is not a safety claim. It means the rules found nothing,
  // over free text they may not have fully parsed. Consumers exclude on
  // `contains` and `may_contain`; nothing in this codebase may present
  // `not_detected` as "free of". (§3.2 — the single most important line in
  // the plan; the same sentence also opens the classifier module, §8.)

  // The Randomizer's exclusion scan: "every recipe where allergen/peanut is
  // contains or may_contain" (§3.3). Per-recipe reads are already covered by
  // the PK's leading `recipe_id`.
  await db.schema.createIndex("recipe_enrichment_label_dimension_slug_verdict_idx").on("recipe_enrichment_label").columns(["dimension", "slug", "verdict", "recipe_id"]).execute();

  await seedVocab(db);
}

// New vocabulary this migration adds (§3.4 / D7). `diet` already has eleven
// upstream-aliased slugs from 1785300000000; this only ADDS to it.
const ALLERGEN_SLUGS: { slug: string; label: string }[] = [
  { slug: "milk", label: "Milk" },
  { slug: "egg", label: "Egg" },
  { slug: "fish", label: "Fish" },
  { slug: "crustacean_shellfish", label: "Crustacean Shellfish" },
  { slug: "tree_nuts", label: "Tree Nuts" },
  { slug: "peanut", label: "Peanut" },
  { slug: "wheat", label: "Wheat" },
  { slug: "soy", label: "Soy" },
  { slug: "sesame", label: "Sesame" },
  { slug: "gluten", label: "Gluten" },
];
const DIET_SLUGS: { slug: string; label: string }[] = [
  { slug: "pescatarian", label: "Pescatarian" },
  { slug: "dairy_free", label: "Dairy Free" },
];

// oxlint-disable-next-line typescript/no-explicit-any
async function seedVocab(db: Kysely<any>): Promise<void> {
  // `source = 'buttery'`: the existing seed's two values are 'seed' (shipped
  // with a migration, but still 1:1 aliased from an upstream
  // `exchange.recipe.defs` token — see 1785300000000's VOCAB table) and
  // 'discovered' (auto-registered from a well-formed upstream token by
  // `registerToken()` in render.ts). Neither fits: these rows are shipped in
  // a migration AND have no upstream token at all — see the D12 note below.
  // A third value keeps 'seed' meaning "traceable to the upstream lexicon"
  // and marks these as Buttery-internal in their own right.
  const rows: { dimension: string; slug: string; label: string; source: string }[] = [
    ...ALLERGEN_SLUGS.map((r) => ({ dimension: "allergen", ...r, source: "buttery" })),
    ...DIET_SLUGS.map((r) => ({ dimension: "diet", ...r, source: "buttery" })),
  ];
  await db.insertInto("recipe_vocab").values(rows).execute();

  // No `recipe_vocab_alias` rows (D12). An alias maps an upstream
  // `exchange.recipe.defs#…` token onto an internal slug; none of these ten
  // allergen slugs (or the two new diet slugs) have an upstream token to map
  // from — the lexicon has no allergen field at all. `registerToken()`'s
  // `DIM_PREFIX` map in `services/pipeline/src/workflows/atproto-sync/lib/
  // render.ts` has no `allergen` entry (and no `pescatarian`/`dairy_free`
  // suffix under `diet`), so `resolveToken()` can never auto-register an
  // alias into `allergen` no matter what a synced record contains — a
  // hostile record structurally cannot invent an allergen. Adding an alias
  // here would be adding a mapping nothing upstream ever produces.
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  // Tables first — dropping them also removes any labels FK-cascaded off a
  // `recipe_vocab` row, though none exist independent of these two tables.
  await db.schema.dropTable("recipe_enrichment_label").ifExists().execute();
  await db.schema.dropTable("recipe_enrichment").ifExists().execute();

  // Delete only the vocab rows THIS migration seeded — never a blanket
  // dimension wipe, since 'diet' already carried eleven rows before this
  // migration ran.
  await db.deleteFrom("recipe_vocab").where("dimension", "=", "allergen").execute();
  await db
    .deleteFrom("recipe_vocab")
    .where("dimension", "=", "diet")
    .where(
      "slug",
      "in",
      DIET_SLUGS.map((r) => r.slug),
    )
    .execute();
}
