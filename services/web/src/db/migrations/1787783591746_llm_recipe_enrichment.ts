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
 *      Management version used, recorded but deliberately NOT part of the
 *      short-circuit — see the column's own comment below and plan §3.1).
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

// ---------------------------------------------------------------------------
// COMMENT ON text — style and placement match `1787772317269_comment_recipe_
// enrichment_sparse_labels.ts`: table/column comments are the only place a
// reader who lands on the schema via `\d+`, a DBA, or kysely-codegen's doc
// passthrough — without first reading the classifier, the workflow types, or
// the plan — can see what an absent row or a stored verdict actually means.
// ---------------------------------------------------------------------------

// Original text from `1787772317269`, kept verbatim so `down` can restore it
// exactly rather than nulling a comment a prior migration is still entitled
// to have set.
const ORIGINAL_LABEL_TABLE_COMMENT = `Sparse: a row is written only when it says something its dimension's default does not.
Absence IS the default, and reads as:
  allergen -> not_detected  (stored verdicts: contains, may_contain, unknown)
  diet     -> not excluded  (stored verdicts: excluded, likely, unknown)

not_detected -- whether stored on a row or implied by a row's absence -- is NOT a
safety claim. It means the rules found nothing over text they may not have fully
parsed. Consumers exclude a recipe on contains and may_contain only; nothing may
present not_detected, or the absence of a row, as "free of".

Absence is only safe to read as the default for slugs that the recipe's
recipe_enrichment.classifier_version actually evaluated -- see that column's
comment. Adding a slug without bumping the version turns "never evaluated" into
"we checked and found nothing", which for an allergen is the exact failure this
whole feature exists to avoid.`;

const ORIGINAL_VERDICT_COLUMN_COMMENT = `allergen: contains | may_contain | not_detected | unknown -- not_detected is also
the default implied when a (recipe, allergen, slug) row is absent.
diet: excluded | likely | unknown -- "not excluded" is the default implied when a
(recipe, diet, slug) row is absent.

not_detected -- stored or implied by absence -- is NOT a safety claim. It means
the rules found nothing over text they may not have fully parsed. Consumers
exclude on contains and may_contain; never render not_detected, or the absence
of a row, as "free of".`;

// Extends the original with the three tag-shaped dimensions and the
// macro/paleo diet slugs, which are governed by `llm_version`, not
// `classifier_version` (llm plan §3.4 — "TWO VERSION COLUMNS, NOT ONE",
// restated in full on `recipe_enrichment.llm_version` below).
const LABEL_TABLE_COMMENT = `Sparse: a row is written only when it says something its dimension's default does not.
Absence IS the default, and reads as:
  allergen -> not_detected  (stored verdicts: contains, may_contain, unknown)
  diet     -> not excluded  (stored verdicts: excluded, likely, unknown)
  cuisine, meal_type, spice_level -> not this one  (stored verdict: likely, always)

not_detected -- whether stored on a row or implied by a row's absence -- is NOT a
safety claim. It means the classifier that owns the dimension (rules, or the LLM
for slugs rules never emit) found nothing over text it may not have fully parsed.
Consumers exclude a recipe on contains and may_contain only; nothing may present
not_detected, or the absence of a row, as "free of".

cuisine / meal_type / spice_level, and the six macro/paleo diet slugs under
'diet' (keto, low_carb, low_fat, low_calorie, diabetic, paleo), are LLM-only:
the rules classifier has no rule for any of them. Absence of one of these rows
is only safe to read as "not this one" for a recipe where
recipe_enrichment.llm_status = 'ok' and recipe_enrichment.llm_version covered
that slug -- a recipe the LLM gate skipped has no such row and has never been
asked, which looks identical to "asked and found nothing" unless you check the
llm_* columns first. Every other dimension/slug's absence is only safe to read
for slugs that recipe_enrichment.classifier_version actually evaluated -- see
that column's comment. Adding a slug to either classifier without bumping its
version column turns "never evaluated" into "we checked and found nothing",
which for an allergen is the exact failure this whole feature exists to avoid.`;

const VERDICT_COLUMN_COMMENT = `allergen: contains | may_contain | not_detected | unknown -- not_detected is also
the default implied when a (recipe, allergen, slug) row is absent.
diet: excluded | likely | unknown -- "not excluded" is the default implied when a
(recipe, diet, slug) row is absent. Six slugs under this dimension (keto,
low_carb, low_fat, low_calorie, diabetic, paleo) are LLM-only -- the rules
classifier never emits them; see the table comment.
cuisine, meal_type, spice_level: likely -- the only verdict these tag-shaped
dimensions ever store. There is no "not this cuisine" verdict; confidence
carries strength and absence carries "not this one" (see the table comment for
the llm_status / llm_version gate that makes that reading safe).

not_detected -- stored or implied by absence -- is NOT a safety claim. It means
the responsible classifier found nothing over text it may not have fully
parsed. Consumers exclude on contains and may_contain; never render
not_detected, or the absence of a row, as "free of".`;

const LLM_STATUS_COLUMN_COMMENT = `null | 'ok' | 'error' | 'skipped' (llm plan §3.1).

null    -- never attempted. The llm-backfill claim signal, same role null plays
           nowhere on the rules side (rules always run synchronously in enrich;
           the LLM pass is the one that can be gated off before it starts).
'ok'    -- llm-enrich ran to completion and wrote its labels. llm_version,
           llm_input_hash, llm_model, llm_prompt_version and llm_enriched_at
           are the record of that run; llm_error is null.
'error' -- llm-enrich ran and failed (schema-invalid model output after
           retries, timeout, provider error). llm_error carries the message,
           not a stack -- an error nobody can see is a failure nobody can see
           (same lesson the sibling 'error' column and atproto_sync_run share).
'skipped' -- the step ran but the gate said no: the env override forced it
           off, the PostHog flag was off/unreachable (fail-closed), or a
           precondition failed (rules row not status='ok', or its input_hash
           is stale for the current content). Recorded, rather than left null,
           so a backfill run while the flag is off does not re-claim the same
           rows on every pass -- the claim query only re-considers 'skipped'
           rows when force or a version bump says to (plan §9.2).`;

// The "TWO VERSION COLUMNS, NOT ONE" invariant. Restates
// `services/pipeline/src/workflows/recipe-enrichment/types.ts`'s note of the
// same name verbatim in intent -- keep the two consistent if either changes.
const LLM_VERSION_COLUMN_COMMENT = `The llm-enrich run that produced (or, for slugs it found nothing to say about,
deliberately omitted) this recipe's llm:-owned recipe_enrichment_label rows.
Defaults to 0, meaning "never run" -- distinct from llm_status IS NULL only in
that this column always has a value; llm_status is the field that actually
gates whether it means anything yet.

TWO VERSION COLUMNS, NOT ONE: a second provider writes into
recipe_enrichment_label under its own method prefix (llm:<provider>:<model>@vN,
alongside the rules' rules@N), so "which version evaluated this slug" now has
two answers, chosen by whichever provider owns the slug:

  - Slugs the rules classifier also emits (every allergen, and the diet slugs
    in EMITTED_DIET_SLUGS): absence still reads as the default once
    recipe_enrichment.classifier_version covered them, exactly as before this
    migration. The LLM only ever ADDS to or escalates these rows; it can never
    make an absence mean less than the rules already made it mean.
  - Slugs only the LLM ever emits (cuisine/*, meal_type/*, spice_level/*, and
    the six macro/paleo diet slugs rules have no rule for): absence means
    NOTHING -- not "not this one", not "not_detected", nothing -- unless
    recipe_enrichment.llm_status = 'ok' AND this column's value covered that
    slug at the time it ran. A recipe the flag skipped and a recipe the LLM
    genuinely evaluated and found nothing for are the same shape in
    recipe_enrichment_label; llm_status and llm_version are the only way to
    tell them apart.

llm/schema.ts pins the LLM half the same way classify.ts pins the rules half:
the emitted slug sets are snapshotted against LLM_ENRICHMENT_VERSION in
llm/schema.test.ts, and changing one without the other fails the suite.`;

const VERDICT_CHECK_CONSTRAINT_COMMENT = `Verdict vocabulary differs by dimension (plan §3.3):
  allergen: contains | may_contain | not_detected | unknown
  diet:     excluded | likely | unknown
  cuisine, meal_type, spice_level: likely (only)

The three new dimensions are TAG-shaped, not exclusion-shaped: there is no
upstream notion of a recipe being definitively "not Thai" the rules/LLM could
assert the way "not_detected" or "excluded" assert an absence claim for an
allergen or a diet. So there is exactly one verdict worth storing --
likely -- and it is only ever written when the classifier has something
positive to say. confidence carries how strongly; the row's absence (see
recipe_enrichment_label's table comment and recipe_enrichment.llm_version's
column comment) carries "not this one", the same sparse-storage logic the
parent plan's D7/§3.2 established for allergen and diet, extended to a third
verdict shape.`;

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // --- recipe_enrichment: LLM state columns (§3.1) -------------------------
  await db.schema
    .alterTable("recipe_enrichment")
    .addColumn("llm_status", "text") // null | 'ok' | 'error' | 'skipped' -- see column comment below
    .addColumn("llm_version", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("llm_input_hash", "text") // same fingerprint as input_hash (D10) -- the LLM classifies the same content
    .addColumn("llm_model", "text") // e.g. 'moonshot:kimi-k2-0905-preview' -- which registry entry actually ran
    .addColumn("llm_prompt_version", "integer") // the PostHog prompt version used; null means the code fallback ran (plan §6.2)
    .addColumn("llm_enriched_at", "timestamptz")
    .addColumn("llm_error", "text") // the message, not a stack -- see llm_status comment
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

  // --- comments (documents the invariants above where a schema reader who
  // never opens types.ts or the plan will actually land) -------------------
  await sql`comment on column recipe_enrichment.llm_status is ${sql.lit(LLM_STATUS_COLUMN_COMMENT)}`.execute(db);
  await sql`comment on column recipe_enrichment.llm_version is ${sql.lit(LLM_VERSION_COLUMN_COMMENT)}`.execute(db);
  await sql`comment on constraint recipe_enrichment_label_verdict_check on recipe_enrichment_label is ${sql.lit(VERDICT_CHECK_CONSTRAINT_COMMENT)}`.execute(db);
  await sql`comment on table recipe_enrichment_label is ${sql.lit(LABEL_TABLE_COMMENT)}`.execute(db);
  await sql`comment on column recipe_enrichment_label.verdict is ${sql.lit(VERDICT_COLUMN_COMMENT)}`.execute(db);
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
  // Comments first, in the reverse order they were set: restore the ORIGINAL
  // two-dimension text this migration overwrote (not null -- that comment
  // belongs to `1787772317269`, not to this migration), and null out the
  // comments this migration alone introduced.
  await sql`comment on column recipe_enrichment_label.verdict is ${sql.lit(ORIGINAL_VERDICT_COLUMN_COMMENT)}`.execute(db);
  await sql`comment on table recipe_enrichment_label is ${sql.lit(ORIGINAL_LABEL_TABLE_COMMENT)}`.execute(db);
  await sql`comment on constraint recipe_enrichment_label_verdict_check on recipe_enrichment_label is null`.execute(db);
  await sql`comment on column recipe_enrichment.llm_version is null`.execute(db);
  await sql`comment on column recipe_enrichment.llm_status is null`.execute(db);

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
