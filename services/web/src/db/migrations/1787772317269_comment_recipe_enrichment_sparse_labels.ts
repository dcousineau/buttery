import { type Kysely, sql } from "kysely";

/**
 * Documents, in the schema itself, the invariant that used to live only in
 * code: `recipe_enrichment_label` is now written SPARSE (recipe-enrichment
 * plan §3.2 revision, `services/pipeline/src/workflows/recipe-enrichment/
 * types.ts`). A row is written only when it says something its dimension's
 * default does not — and a schema reader looking at the table alone has no
 * way to see that an absent row is itself a verdict. `COMMENT ON` is the only
 * place that invisibility can be fixed for anyone who reaches this schema
 * without reading the classifier or the workflow types first: `psql`'s `\d+`,
 * a DBA, a future migration author, kysely-codegen's doc-comment passthrough.
 *
 * Comments only. No DDL, no data change — nothing here can fail a running
 * writer or reader, and `down` simply nulls every comment this sets.
 *
 * Three placements, not one, because the invariant has three distinct parts
 * and each belongs to the object it is actually about:
 *   - `recipe_enrichment_label` (table)   — the sparse-storage shape itself:
 *     what absence means, per dimension.
 *   - `recipe_enrichment_label.verdict`   — the stored vocabulary, and the
 *     `not_detected` safety caveat (repeated here verbatim from the table
 *     that created it, the classifier module, and the workflow's types —
 *     absence is now the usual way that sentence is expressed, so it belongs
 *     wherever a reader might land).
 *   - `recipe_enrichment.classifier_version` — the ONLY thing that makes
 *     reading absence as a default safe at all: it is safe solely for slugs
 *     that version actually evaluated. This table has no way to enforce that
 *     itself (`classify.ts`'s snapshot test is what actually pins it); the
 *     comment exists so nobody reading the schema mistakes silence for an
 *     enforced guarantee.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not
 * track the evolving `DB` interface (matches the existing migrations).
 */

const LABEL_TABLE_COMMENT = `Sparse: a row is written only when it says something its dimension's default does not.
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

const VERDICT_COLUMN_COMMENT = `allergen: contains | may_contain | not_detected | unknown -- not_detected is also
the default implied when a (recipe, allergen, slug) row is absent.
diet: excluded | likely | unknown -- "not excluded" is the default implied when a
(recipe, diet, slug) row is absent.

not_detected -- stored or implied by absence -- is NOT a safety claim. It means
the rules found nothing over text they may not have fully parsed. Consumers
exclude on contains and may_contain; never render not_detected, or the absence
of a row, as "free of".`;

const CLASSIFIER_VERSION_COLUMN_COMMENT = `The classifier run that produced (or, for slugs it found nothing to say about,
deliberately omitted) this recipe's recipe_enrichment_label rows.

A missing label row is readable as its dimension's default ONLY for slugs this
version of the classifier actually evaluates -- never for every slug that has
ever existed, or will ever exist, in recipe_vocab. Add a slug to what the
classifier evaluates without bumping this column's value, and every
already-classified recipe silently reports the default for a slug nothing ever
looked at: "never evaluated" becomes indistinguishable from "we checked and
found nothing".`;

const ENRICHMENT_TABLE_COMMENT = `One row per recipe: the enrichment run's status plus classifier_version, which
gates how recipe_enrichment_label's sparse absence may be read for this recipe
-- see that column's comment.`;

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await sql`comment on table recipe_enrichment_label is ${sql.lit(LABEL_TABLE_COMMENT)}`.execute(db);
  await sql`comment on column recipe_enrichment_label.verdict is ${sql.lit(VERDICT_COLUMN_COMMENT)}`.execute(db);
  await sql`comment on table recipe_enrichment is ${sql.lit(ENRICHMENT_TABLE_COMMENT)}`.execute(db);
  await sql`comment on column recipe_enrichment.classifier_version is ${sql.lit(CLASSIFIER_VERSION_COLUMN_COMMENT)}`.execute(db);
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`comment on table recipe_enrichment_label is null`.execute(db);
  await sql`comment on column recipe_enrichment_label.verdict is null`.execute(db);
  await sql`comment on table recipe_enrichment is null`.execute(db);
  await sql`comment on column recipe_enrichment.classifier_version is null`.execute(db);
}
