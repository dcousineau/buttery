import { type Kysely, sql } from "kysely";

/**
 * LLM second-opinion classifier — schema half. See
 * `docs/plans/2026-08-26-llm-recipe-enrichment.md` §3 (all subsections); this
 * migration is §3.1–§3.3 verbatim. The code half (`llm/` under
 * `services/pipeline/src/workflows/recipe-enrichment/`) is a separate slice.
 *
 * Three changes, all against tables `1787679680100_create_recipe_enrichment`
 * created:
 *
 *   1. `recipe_enrichment` gains an `llm_*` column family that mirrors its
 *      existing `status`/`classifier_version`/`input_hash`/`enriched_at`/
 *      `error` columns 1:1, `llm_`-prefixed, for the second provider (§3.1).
 *      Two extra columns the rules side has no analogue for: `llm_model`
 *      (which provider:model actually ran — the registry is env-selected,
 *      §6.1 of the plan) and `llm_prompt_version` (the PostHog Prompt
 *      Management version used — plan §3.1). Both were record-only when this
 *      migration landed; `isLlmFresh` has since made them part of the
 *      `llm-enrich` short-circuit, so a model swap or a newly released prompt
 *      re-runs unchanged recipes.
 *      A matching claim index supports `llm-backfill` the same way
 *      `recipe_enrichment_status_version_idx` supports the rules `backfill`.
 *
 *   2. Three new `recipe_vocab` dimensions the LLM alone judges: `cuisine`,
 *      `meal_type`, `spice_level` (§3.2). Seeded like `1787679680100`'s
 *      allergen rows — internal `source`, no `recipe_vocab_alias` rows — with
 *      one wrinkle documented in `seedVocab` below: `cuisine` is NOT a new
 *      dimension in this table, and only 6 of the plan's 24 slugs are
 *      actually new rows. Read that comment before touching the constant
 *      lists.
 *
 *   3. `recipe_enrichment_label`'s verdict check constraint grows a third arm
 *      for the three tag-shaped dimensions (§3.3): the only verdict they ever
 *      store is `likely`; there is no exclusion/uncertainty vocabulary for
 *      "this recipe is not Italian" the way there is for an allergen or a
 *      diet. `confidence` carries strength; absence carries "not this one".
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not
 * track the evolving `DB` interface (matches the existing migrations).
 */

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // --- recipe_enrichment: LLM state columns (§3.1) -------------------------
  await db.schema
    .alterTable("recipe_enrichment")
    .addColumn("llm_status", "text") // null | 'ok' | 'error' | 'skipped' (plan §3.1)
    .addColumn("llm_version", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("llm_input_hash", "text") // same fingerprint as input_hash (D10) -- the LLM classifies the same content
    .addColumn("llm_model", "text") // e.g. 'openrouter:mistralai/mistral-small-24b-instruct-2501' -- which registry entry actually ran
    .addColumn("llm_prompt_version", "integer") // the PostHog prompt version used; null means the code fallback ran (plan §6.2)
    .addColumn("llm_enriched_at", "timestamptz")
    .addColumn("llm_error", "text") // the message, not a stack
    .execute();

  // The llm-backfill claim query (plan §9.2): rows where the rules pass
  // succeeded (status='ok', a precondition the step itself checks) and the
  // LLM pass is missing, errored, or behind the current
  // LLM_ENRICHMENT_VERSION. Mirrors recipe_enrichment_status_version_idx's
  // shape (a plain composite btree over exactly the columns the claim query
  // filters on) rather than a partial index, matching that index's precedent.
  await db.schema.createIndex("recipe_enrichment_status_llm_version_idx").on("recipe_enrichment").columns(["status", "llm_status", "llm_version"]).execute();

  // --- recipe_enrichment_label: extended verdict check (§3.3) --------------
  await db.schema.alterTable("recipe_enrichment_label").dropConstraint("recipe_enrichment_label_verdict_check").execute();
  await db.schema
    .alterTable("recipe_enrichment_label")
    .addCheckConstraint(
      "recipe_enrichment_label_verdict_check",
      sql`(
        (dimension = 'allergen' and verdict in ('contains','may_contain','not_detected','unknown'))
        or (dimension = 'diet' and verdict in ('excluded','likely','unknown'))
        or (dimension in ('cuisine','meal_type','spice_level') and verdict = 'likely')
      )`,
    )
    .execute();

  await seedVocab(db);
}

// New vocabulary this migration adds (plan §3.2).
//
// meal_type and spice_level are genuinely new dimensions -- nothing in
// recipe_vocab used either name before this migration.
const MEAL_TYPE_SLUGS: { slug: string; label: string }[] = [
  { slug: "breakfast", label: "Breakfast" },
  { slug: "lunch", label: "Lunch" },
  { slug: "dinner", label: "Dinner" },
  { slug: "dessert", label: "Dessert" },
  { slug: "snack", label: "Snack" },
  { slug: "side", label: "Side" },
  { slug: "drink", label: "Drink" },
];
const SPICE_LEVEL_SLUGS: { slug: string; label: string }[] = [
  { slug: "mild", label: "Mild" },
  { slug: "medium", label: "Medium" },
  { slug: "hot", label: "Hot" },
];

// cuisine is NOT a new dimension. `1785300000000_create_recipe_rendered.ts`
// already seeded a `cuisine` dimension of 32 upstream-aliased slugs (from
// `exchange.recipe.defs#cuisine*`), and 18 of the LLM plan's 24-slug v1 list
// (plan §3.2) collide EXACTLY on slug string with rows that migration already
// inserted: italian, french, spanish, greek, mexican, tex_mex, american,
// caribbean, brazilian, peruvian, middle_eastern, turkish, indian, thai,
// vietnamese, chinese, japanese, korean. Those 18 already satisfy
// recipe_enrichment_label's FK to recipe_vocab (dimension, slug) -- nothing
// needs to be inserted for them, and inserting them again would violate
// recipe_vocab_pkey (dimension, slug). Only the 6 slugs genuinely absent from
// that seed are new rows here:
//   southern_us, cajun_creole, north_african, ethiopian, west_african,
//   eastern_european
// (the closest existing rows are 'southern' and 'creole' -- different slugs,
// left untouched -- and there was previously no African or Eastern European
// split at all). This does NOT contradict the LLM's closed CuisineSlug enum
// (`llm/schema.ts`, plan §3.2/L12) or its FK requirement: all 24 slugs the
// LLM may emit exist as recipe_vocab rows after this migration, 18 of them
// having existed since 1785300000000. It does contradict this plan's own
// framing of cuisine as one of "three new dimensions" -- flagged in the
// implementation results doc; see that file for the full note.
const NEW_CUISINE_SLUGS: { slug: string; label: string }[] = [
  { slug: "southern_us", label: "Southern US" },
  { slug: "cajun_creole", label: "Cajun/Creole" },
  { slug: "north_african", label: "North African" },
  { slug: "ethiopian", label: "Ethiopian" },
  { slug: "west_african", label: "West African" },
  { slug: "eastern_european", label: "Eastern European" },
];

// oxlint-disable-next-line typescript/no-explicit-any
async function seedVocab(db: Kysely<any>): Promise<void> {
  // `source = 'buttery'`, matching `1787679680100`'s allergen/pescatarian/
  // dairy_free seed: these rows are shipped in a migration and have no
  // upstream token to trace to, so neither 'seed' (upstream-aliased) nor
  // 'discovered' (auto-registered from a synced record) fits.
  const rows: { dimension: string; slug: string; label: string; source: string }[] = [
    ...NEW_CUISINE_SLUGS.map((r) => ({ dimension: "cuisine", ...r, source: "buttery" })),
    ...MEAL_TYPE_SLUGS.map((r) => ({ dimension: "meal_type", ...r, source: "buttery" })),
    ...SPICE_LEVEL_SLUGS.map((r) => ({ dimension: "spice_level", ...r, source: "buttery" })),
  ];
  await db.insertInto("recipe_vocab").values(rows).execute();

  // No `recipe_vocab_alias` rows (D12, restated for these three dimensions).
  // An alias maps an upstream `exchange.recipe.defs#…` token onto an internal
  // slug; meal_type and spice_level have no upstream field at all, and the 6
  // new cuisine slugs above have no upstream suffix either (the upstream
  // lexicon's own cuisine list is the 32-suffix set 1785300000000 already
  // aliased in full -- these 6 are Buttery-internal refinements the LLM
  // distinguishes that the upstream vocabulary never named). `registerToken()`
  // in `services/pipeline/src/workflows/atproto-sync/lib/render.ts` has no
  // `meal_type` or `spice_level` entry in its `DIM_PREFIX` map, so
  // `resolveToken()` can never auto-register an alias into either dimension
  // no matter what a synced record contains -- a hostile record structurally
  // cannot invent a meal_type or spice_level any more than it can invent an
  // allergen. `cuisine` DOES have a `DIM_PREFIX` entry (from 1785300000000),
  // but only for the original `cuisine` prefix/suffix pairs, which are
  // already aliased; nothing upstream can produce a token that resolves to
  // one of these 6 new slugs.
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  // Delete only the vocab rows THIS migration seeded: all of meal_type and
  // spice_level (this migration created both dimensions outright), and only
  // the 6 cuisine slugs it added -- never a blanket `dimension = 'cuisine'`
  // wipe, since that dimension carried 32 rows before this migration ran.
  await db.deleteFrom("recipe_vocab").where("dimension", "=", "meal_type").execute();
  await db.deleteFrom("recipe_vocab").where("dimension", "=", "spice_level").execute();
  await db
    .deleteFrom("recipe_vocab")
    .where("dimension", "=", "cuisine")
    .where(
      "slug",
      "in",
      NEW_CUISINE_SLUGS.map((r) => r.slug),
    )
    .execute();

  // Restore the ORIGINAL two-arm verdict check constraint (§3.3 pre-image).
  await db.schema.alterTable("recipe_enrichment_label").dropConstraint("recipe_enrichment_label_verdict_check").execute();
  await db.schema
    .alterTable("recipe_enrichment_label")
    .addCheckConstraint(
      "recipe_enrichment_label_verdict_check",
      sql`(
        (dimension = 'allergen' and verdict in ('contains','may_contain','not_detected','unknown'))
        or (dimension = 'diet' and verdict in ('excluded','likely','unknown'))
      )`,
    )
    .execute();

  await db.schema.dropIndex("recipe_enrichment_status_llm_version_idx").execute();

  await db.schema
    .alterTable("recipe_enrichment")
    .dropColumn("llm_error")
    .dropColumn("llm_enriched_at")
    .dropColumn("llm_prompt_version")
    .dropColumn("llm_model")
    .dropColumn("llm_input_hash")
    .dropColumn("llm_version")
    .dropColumn("llm_status")
    .execute();
}
