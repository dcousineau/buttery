import { type Kysely, sql } from "kysely";
import { contentFingerprint, normalizeSourceUrl } from "@buttery/recipe-schemas/normalize";

/**
 * Backfill the two dedupe keys for every recipe that already exists. See
 * `docs/plans/2026-08-09-paprika-import.md` §6.5.
 *
 * ── WHY THIS IS MANDATORY, NOT AN OPTIMIZATION (§6.5, D18) ────────────────
 * The import pipeline decides "is this recipe already in your box?" by looking
 * for a matching `recipe_meta (ns='dedupe')` row. Recipes that predate that
 * table have none. Without this backfill the household-box check matches
 * NOTHING, every existing recipe reads as `new`, and the very first import
 * cheerfully duplicates the user's entire box — silently, with no error to
 * notice. Skipping this migration does not degrade dedupe, it deletes it.
 *
 * ── WHY THE COMPUTATION IS IN TYPESCRIPT, NOT SQL (§6.5, §16.15) ──────────
 * The keys are only useful if a backfilled value is byte-identical to the one
 * the runtime writers produce for the same recipe (§6.6 lists all three of
 * them). A SQL reimplementation of NFKC folding, diacritic stripping and the
 * URL rules would be a second implementation to keep in sync forever, and the
 * day it drifts the failure is invisible: keys that simply never match. So the
 * migration calls the SAME `@buttery/recipe-schemas/normalize` functions the
 * writers call. A divergent backfill is worse than none.
 *
 * `contentFingerprint` digests through `globalThis.crypto.subtle`, which is
 * available in the Node runtime kysely-ctl runs under — hence the `await`s.
 *
 * ── SHAPE ────────────────────────────────────────────────────────────────
 * Batched by keyset over `recipe.id`: one query per batch for the recipes (+
 * their `website` attribution), one for that batch's ingredient lines, one
 * insert. Never a query per recipe. The insert is `on conflict do update`, so
 * re-running after a partial failure — or after a writer has already written a
 * key — converges rather than erroring.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not
 * track the evolving `DB` interface (matches the existing migrations).
 */

/** How many recipes are pulled, fingerprinted and inserted per round trip. */
const BATCH = 200;

/** One recipe's inputs to the key computation, read straight off the tables. */
export interface DedupeBackfillInput {
  readonly recipeId: string;
  readonly name: string;
  /** `recipe_attribution.url` where `kind = 'website'`; null when there is none. */
  readonly sourceUrl: string | null;
  /** `recipe_ingredient.text`, in stored (`ordinal`) order. */
  readonly ingredients: readonly string[];
}

/** A row destined for `recipe_meta` with `ns = 'dedupe'`. */
export interface DedupeMetaRow {
  readonly recipeId: string;
  readonly key: "source_url_key" | "content_fp";
  readonly value: string;
}

/**
 * The whole of the backfill's per-recipe logic, exported and pure so a test can
 * assert it against the runtime computation without standing up a migration
 * (§16.15). The migration below calls nothing else — there is no second copy of
 * this to drift.
 *
 * A recipe with no source URL, or one that does not normalize (mailto:, a bare
 * string, an empty host), gets NO `source_url_key` row — absence is the signal,
 * not a null value (§6.1). `content_fp` is always written, even for a recipe
 * with no ingredients: an empty ingredient list still fingerprints its name,
 * and two recipes that are genuinely both name-only genuinely are duplicates.
 */
export async function dedupeMetaRowsFor(input: DedupeBackfillInput): Promise<DedupeMetaRow[]> {
  const rows: DedupeMetaRow[] = [];
  const sourceUrlKey = normalizeSourceUrl(input.sourceUrl);
  if (sourceUrlKey) rows.push({ recipeId: input.recipeId, key: "source_url_key", value: sourceUrlKey });
  rows.push({ recipeId: input.recipeId, key: "content_fp", value: await contentFingerprint(input.name, input.ingredients) });
  return rows;
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // Keyset cursor over `recipe.id` (a ULID, and the PK): stable under the
  // inserts this migration itself performs, unlike offset paging.
  let cursor: string | null = null;
  let recipes = 0;
  let metaRows = 0;

  for (;;) {
    // One row per recipe. The `website` attribution is joined in rather than
    // fetched per recipe; `recipe_attribution` is 1:1 (recipe_id is its PK), so
    // the left join cannot fan out.
    let query = db
      .selectFrom("recipe as r")
      .leftJoin("recipe_attribution as a", (join) => join.onRef("a.recipe_id", "=", "r.id").on("a.kind", "=", "website"))
      .select(["r.id as id", "r.name as name", "a.url as source_url"])
      .orderBy("r.id")
      .limit(BATCH);
    if (cursor !== null) query = query.where("r.id", ">", cursor);

    const batch: Array<{ id: string; name: string | null; source_url: string | null }> = await query.execute();
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    // Second (and last) read for this batch: every ingredient line for all of
    // them, ordered by the table's ordering column so the lines arrive in the
    // order they are stored. `contentFingerprintInput` sorts internally, so the
    // fingerprint does not depend on this — but reading a recipe's ingredients
    // in an arbitrary order is a bug waiting for the next reader who does care.
    const ids = batch.map((r) => r.id);
    const lines: Array<{ recipe_id: string; text: string }> = await db
      .selectFrom("recipe_ingredient")
      .select(["recipe_id", "text"])
      .where("recipe_id", "in", ids)
      .orderBy("recipe_id")
      .orderBy("ordinal")
      .execute();

    const byRecipe = new Map<string, string[]>();
    for (const id of ids) byRecipe.set(id, []);
    for (const line of lines) byRecipe.get(line.recipe_id)?.push(line.text);

    const values: Array<{ recipe_id: string; ns: string; key: string; value: unknown }> = [];
    for (const recipe of batch) {
      const computed = await dedupeMetaRowsFor({
        recipeId: recipe.id,
        // `recipe.name` is NOT NULL in schema, but the backfill must not throw
        // on a row that somehow is not; an empty name still fingerprints.
        name: recipe.name ?? "",
        sourceUrl: recipe.source_url,
        ingredients: byRecipe.get(recipe.id) ?? [],
      });
      for (const row of computed) {
        // `value` is jsonb: store the key as a JSON string, which is what the
        // `recipe_meta_dedupe` partial index (`(value #>> '{}')`) searches on.
        values.push({ recipe_id: row.recipeId, ns: "dedupe", key: row.key, value: sql`to_jsonb(${row.value}::text)` });
      }
    }

    if (values.length > 0) {
      // Idempotent: a re-run, or a writer that got there first, updates in
      // place instead of failing the migration on the composite PK.
      await db
        .insertInto("recipe_meta")
        .values(values)
        .onConflict((oc) => oc.columns(["recipe_id", "ns", "key"]).doUpdateSet((eb) => ({ value: eb.ref("excluded.value"), updated_at: sql`now()` })))
        .execute();
    }

    recipes += batch.length;
    metaRows += values.length;
    if (batch.length < BATCH) break;
  }

  // Loud on purpose: this runs against production data and the operator should
  // see how much it touched, not have to query for it afterwards.
  console.log(`[backfill_recipe_dedupe_keys] ${recipes} recipes → ${metaRows} recipe_meta rows`);
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  // Only this migration's namespace. `recipe_meta` itself belongs to the
  // previous migration, and other namespaces (`llm.enhance`, …) are not ours to
  // drop. Rolling back genuinely means "the box check matches nothing again".
  await db.deleteFrom("recipe_meta").where("ns", "=", "dedupe").execute();
}
