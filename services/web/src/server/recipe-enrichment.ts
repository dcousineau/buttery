import type { Kysely } from "kysely";
import type { DB, JsonValue } from "#/db/types";
import type { RecipeTagLabel } from "#/lib/recipe-tags";

/**
 * Read surface for the recipe-enrichment pipeline (recipe-enrichment plan §10).
 * Server-only, and deliberately thin: `getRecipeEnrichment` is a `select` over
 * `recipe_enrichment` plus its labels, grouped by dimension, and nothing else.
 *
 * ── NEVER WRITTEN BACK (D1) ────────────────────────────────────────────────
 * Everything here is READ-ONLY. The enrichment pipeline's derived facts are
 * never written to `recipe.suitable_for_diet`, `recipe.calories` or any
 * `*_content` column — those are what the author declared, and a derived
 * verdict never overwrites a declaration. When the two disagree, both stand;
 * this module just shows them side by side. This module writes nothing at
 * all — the pipeline (`services/pipeline`) is the only writer of
 * `recipe_enrichment` / `recipe_enrichment_label`.
 *
 * ── NEVER PUBLISHED ────────────────────────────────────────────────────────
 * Same rule `recipe-meta.ts` states: nothing read here is ever written into an
 * `exchange.recipe.recipe` record or published to a PDS. Derived facts are
 * Buttery-internal.
 *
 * ── LABELS ARE SPARSE: THIS MODULE PASSES THAT THROUGH, ON PURPOSE ─────────
 * `recipe_enrichment_label` is written sparse (`services/pipeline/src/
 * workflows/recipe-enrichment/types.ts`, which is the contract — read it
 * before touching this file): a row exists only when it says something its
 * dimension's default does not. Absence IS the default, and reads as:
 *
 *   | dimension | absence means  | stored verdicts                      |
 *   | --------- | --------------- | ------------------------------------ |
 *   | allergen  | `not_detected`  | `contains`, `may_contain`, `unknown`  |
 *   | diet      | `not excluded`  | `excluded`, `likely`, `unknown`       |
 *
 * `getRecipeEnrichment` returns EXACTLY the rows stored, grouped by dimension
 * — it does not synthesize a row for every `recipe_vocab` slug. Two ways this
 * could have gone, and why this one was chosen:
 *
 *   - Materialize: left-join `recipe_vocab` and fill in the default verdict
 *     for every slug the row's dimension has, so a caller always sees a full
 *     grid. Convenient, but wrong to do honestly from here: it would have to
 *     materialize only the slugs `recipe_enrichment.classifier_version`
 *     actually evaluated — a fact `EMITTED_DIET_SLUGS`/`ALLERGEN_SLUGS` and
 *     their version history record in the pipeline, not in this database. Web
 *     does not depend on `services/pipeline` (only on the shared
 *     `@buttery/pipeline-contract` package for queue/job shapes), so getting
 *     that mapping right here would mean forking a second copy of it that
 *     drifts the moment the classifier's emitted-slug sets change. Get the
 *     scoping wrong and this module reintroduces the exact failure sparse
 *     storage exists to prevent: presenting "never evaluated" as "checked,
 *     found nothing" — for an allergen, unacceptable.
 *   - Pass through sparse (chosen): return what is stored; document the
 *     defaults (above, and repeated on the `recipe_enrichment_label` table's
 *     `COMMENT` in the migration that added it) so a caller applies them.
 *     This module's declared consumer, the Randomizer, only ever needs to
 *     ANSWER "is this recipe excluded" — `contains`/`may_contain` for an
 *     allergen, `excluded` for a diet — and a sparse row set already answers
 *     that with no materialization at all: a missing row already means "not
 *     excluded" for that slug. Nothing here re-inflates in memory what the
 *     pipeline just avoided writing to disk.
 *
 * A caller that DOES need the full grid (e.g. a future settings UI listing
 * every allergen with its status) must do its own bounded join against
 * `recipe_vocab`, scoped to the slugs it knows `classifierVersion` covers —
 * that scoping knowledge belongs at the call site, not baked into this shared
 * read helper as a guess.
 *
 * ── `not_detected` IS NOT A SAFETY CLAIM (§3.2) ────────────────────────────
 * An `allergen` label's `not_detected` verdict — whether stored on a row or
 * implied by a row's absence — means the rules found nothing, over free text
 * they may not have fully parsed — NOT that the dish is free of that
 * allergen. No caller of this module may render `not_detected`, or the
 * absence of a label, as "free of", "safe" or anything else a reader could
 * act on.
 *
 * ── THERE IS NO SERVER FN HERE ANY MORE ────────────────────────────────────
 * This module used to also export a dev-gated `getRecipeEnrichmentDebug`
 * server fn, feeding a panel pinned to the recipe detail route. That's gone:
 * the devtools Recipe inspector (`devtools/`, served by
 * `server/recipe-debug.ts`) shows the same underlying `recipe_enrichment` /
 * `recipe_enrichment_label` rows and a great deal more, via its own direct
 * query — it does NOT call `getRecipeEnrichment` below, so it carries its own
 * copy of the `not_detected`/sparse caveats in its section notes rather than
 * inheriting this module's. Keeping a second dev-gated endpoint with no
 * caller would have left a live route nobody was using; the double gate that
 * mattered moved with it and is documented there.
 *
 * What remains is the plain read helper below — plan §10's read surface, whose
 * declared consumer is the Randomizer. It takes `db` as a parameter and does no
 * session work of its own, so any caller must bring its own authorization; the
 * one in `recipe-debug.ts` is the model.
 */

/**
 * What an ABSENT `recipe_enrichment_label` row means, per dimension — see the
 * module doc's sparse-labels table. Not itself a stored verdict: `allergen`'s
 * default happens to also be a value the table can store (`not_detected` is
 * stored, deliberately, when the rules could only partially read the recipe);
 * `diet` has no "not excluded" token to store, only the row's absence.
 */
export const SPARSE_LABEL_DEFAULT = {
  allergen: "not_detected",
  diet: "not excluded",
} as const;

/**
 * One `recipe_enrichment_label` row, exactly as stored — this module does not
 * synthesize rows for absent slugs (module doc, "LABELS ARE SPARSE"). A slug
 * missing from a dimension's array is that dimension's default
 * (`SPARSE_LABEL_DEFAULT`), but only for a slug `classifierVersion` actually
 * evaluated.
 */
export interface RecipeEnrichmentLabelView {
  dimension: string;
  slug: string;
  verdict: string;
  confidence: number;
  method: string;
  /** Which lines and food slugs fired, and which rule (§8.3). Shape is per-classifier. */
  evidence: JsonValue | null;
  updatedAt: string;
}

/** `recipe_enrichment` plus its SPARSE labels, grouped by dimension (`diet` / `allergen`) — see the module doc. */
export interface RecipeEnrichmentView {
  recipeId: string;
  status: string;
  classifierVersion: number;
  inputHash: string | null;
  enrichedAt: string | null;
  /** A message, not a stack (§3.1) — safe to render as-is. */
  error: string | null;
  labels: Record<string, RecipeEnrichmentLabelView[]>;
}

/** `numeric` comes back from `pg` as a string. Mirrors `grocery.ts` / `household-recipes.ts`. */
function toNum(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The `recipe_enrichment` row plus its labels, grouped by dimension.
 *
 * `null` when nothing has run for this recipe yet — no writer has ever marked
 * it `stale`, so there is no row at all. That is a real, distinct state from
 * `status: "error"` (a job ran and failed) and from `status: "stale"` (a write
 * landed and the worker hasn't caught up), and callers should tell them apart.
 *
 * `labels` is exactly the sparse row set — no synthesized entries for absent
 * slugs. A recipe with two stored allergen rows out of ten `recipe_vocab`
 * allergen slugs comes back with an array of two, not ten; see the module
 * doc for why this is deliberate and `SPARSE_LABEL_DEFAULT` for what a caller
 * should treat a missing slug as.
 *
 * Plain exported function taking `db` first, per the `grocery.ts` pattern, so
 * `recipe-enrichment.db.test.ts` can reach it without faking a session.
 */
export async function getRecipeEnrichment(db: Kysely<DB>, recipeId: string): Promise<RecipeEnrichmentView | null> {
  const row = await db.selectFrom("recipe_enrichment").selectAll().where("recipe_id", "=", recipeId).executeTakeFirst();
  if (!row) return null;

  const labelRows = await db.selectFrom("recipe_enrichment_label").selectAll().where("recipe_id", "=", recipeId).orderBy("dimension").orderBy("slug").execute();

  const labels: Record<string, RecipeEnrichmentLabelView[]> = {};
  for (const label of labelRows) {
    const bucket = labels[label.dimension] ?? (labels[label.dimension] = []);
    bucket.push({
      dimension: label.dimension,
      slug: label.slug,
      verdict: label.verdict,
      confidence: toNum(label.confidence),
      method: label.method,
      evidence: label.evidence ?? null,
      updatedAt: new Date(label.updated_at).toISOString(),
    });
  }

  return {
    recipeId: row.recipe_id,
    status: row.status,
    classifierVersion: row.classifier_version,
    inputHash: row.input_hash,
    enrichedAt: row.enriched_at ? new Date(row.enriched_at).toISOString() : null,
    error: row.error,
    labels,
  };
}

// --- the display seam ------------------------------------------------------

/**
 * `method`'s `llm:` prefix is the schema's actual ownership rule
 * (`db/types.ts`'s `recipe_enrichment_label.method` comment, and the
 * pipeline's `writeEnrichment`/`writeLlmEnrichment`, which delete-and-replace
 * by exactly this prefix). Restated here rather than imported from
 * `services/pipeline`, for the same reason this module's doc gives and
 * `recipe-debug.ts` repeats: web does not depend on the pipeline's internals.
 */
const LLM_METHOD_PREFIX = "llm:";

/** The dimensions the tag strip knows how to render. Anything else is dropped rather than passed through untyped. */
const TAG_DIMENSIONS = new Set<RecipeTagLabel["dimension"]>(["allergen", "diet", "cuisine", "meal_type", "spice_level"]);

/**
 * Pull `evidence.note` out of a label's untyped `evidence` jsonb.
 *
 * `evidence` is `JsonValue` at this boundary — its shape is per-classifier and
 * nothing enforces it in the database — so this destructures defensively and
 * returns `null` for every shape that is not "an object with a string `note`".
 * Done ONCE, here, so neither the wire type nor the client has to carry an
 * unknown-shaped field or repeat this guard.
 */
function evidenceNote(evidence: JsonValue | null): string | null {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) return null;
  const note = (evidence as Record<string, JsonValue | undefined>).note;
  return typeof note === "string" && note.trim().length > 0 ? note : null;
}

/**
 * Flatten a {@link RecipeEnrichmentView} into what the recipe surfaces render
 * — the first production consumer of this module.
 *
 * Three things happen here and nowhere else:
 *
 *  1. **Source is derived from `method`**, not stored separately.
 *  2. **`evidence` collapses to `note`**, so the untyped jsonb stops at the
 *     server boundary instead of riding to the browser.
 *  3. **`confidence` is dropped.** It is not on {@link RecipeTagLabel} at all,
 *     which is what makes leaking it a type error rather than an oversight —
 *     see `lib/recipe-tags.ts`'s module doc for why a hardcoded tier constant
 *     should not be shown as a probability.
 *
 * `null` in, `null` out: a recipe nothing has ever enriched is a distinct state
 * from one enriched to no labels, and the caller keeps that distinction.
 *
 * NOTE this does NOT apply the verdict policy — `not_detected` and friends come
 * through here and are dropped by `mergeRecipeTags`. One place owns that
 * policy, and it is the one with the tests.
 */
export function enrichmentTagLabels(view: RecipeEnrichmentView | null): RecipeTagLabel[] | null {
  if (!view) return null;
  const out: RecipeTagLabel[] = [];
  for (const [dimension, rows] of Object.entries(view.labels)) {
    if (!TAG_DIMENSIONS.has(dimension as RecipeTagLabel["dimension"])) continue;
    for (const row of rows) {
      out.push({
        dimension: dimension as RecipeTagLabel["dimension"],
        slug: row.slug,
        verdict: row.verdict,
        source: row.method.startsWith(LLM_METHOD_PREFIX) ? "llm" : "rules",
        note: evidenceNote(row.evidence),
        method: row.method,
      });
    }
  }
  return out;
}
