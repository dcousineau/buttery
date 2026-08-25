import type { FoodMatch } from "@buttery/food/categorize";

/**
 * The vocabulary this workflow's halves exchange — the job payloads, and the
 * shapes a classifier reads and writes.
 *
 * It lives in a file of its own for the same reason `atproto-sync/types.ts`
 * does: the payloads are JSON in Redis, written by one deployment and possibly
 * read by the next, so they have to stay small and stay stable. The
 * classification shapes are here for a different reason — `classify.ts` and
 * `steps.ts` must agree on them exactly, and neither should have to import the
 * other to find out.
 *
 * ── `not_detected` IS NOT A SAFETY CLAIM (plan §3.2) ───────────────────────
 * It means the rules found nothing, over free text they may not have fully
 * parsed. A consumer excludes a recipe on `contains` and `may_contain`; nothing
 * in this codebase may present `not_detected` as "free of". The same sentence is
 * in the migration and at the top of the classifier module, and it is the single
 * most important line in this plan.
 */

// --- job payloads ----------------------------------------------------------

/**
 * `enrich`'s payload lives in `@buttery/pipeline-contract`, not here: the web
 * app enqueues these too, and a shape only one side can name is the failure that
 * package exists to prevent (plan §5). Re-exported so this folder has one place
 * to look.
 */
export type { EnrichPayload } from "@buttery/pipeline-contract";

/** `backfill`'s payload. Every field optional; the step owns the defaults and the cap. */
export interface BackfillPayload {
  /** Recipes to claim this run. Defaults to 500, hard-capped at 5000 (plan §7.2). */
  limit?: number;
  /** Re-classify even when the fingerprint and classifier version already match. */
  force?: boolean;
  /** Claim only `origin='local'` recipes — somebody's own, not the network's. */
  localOnly?: boolean;
}

/** What `backfill` hands its report parent, and what the report folds children into. */
export interface BackfillReportPayload {
  claimed: number;
  /** Candidates still outstanding after this batch, so a second POST is informed. */
  remaining: number;
  force: boolean;
  localOnly: boolean;
}

// --- what a classifier reads ----------------------------------------------

/** Open Food Facts' own tri-state, as `traits.json` encodes it. */
export type TriState = 0 | 1 | 2;
export const TRAIT_NO = 0 satisfies TriState;
export const TRAIT_YES = 1 satisfies TriState;
export const TRAIT_MAYBE = 2 satisfies TriState;

/**
 * One food's derived facts, structurally identical to `@buttery/food/traits`'
 * `FoodTraits`.
 *
 * Declared structurally rather than imported so a classifier depends on the
 * *shape* of a trait rather than on where this deployment happens to get one:
 * a later provider (§8's seam) can synthesize traits for a food the lexicon
 * never resolved without the classifiers noticing.
 */
export interface IngredientTraits {
  /** Vegan. */
  vg?: TriState;
  /** Vegetarian. */
  vt?: TriState;
  /** Allergen slugs this food carries — `AllergenSlug[]`, widened for the seam above. */
  al?: readonly string[];
  /** Coarse tags: `meat`, `pork`, `alcohol`, `seafood`. */
  tg?: readonly string[];
}

/** One `recipe_ingredient` row, parsed and matched. */
export interface ClassifierLine {
  /** `recipe_ingredient.ordinal` — what evidence cites, so "line 7" means something. */
  ordinal: number;
  /** The line as written. */
  text: string;
  /** The food, cleaned of prep clauses — `parse.ts`'s `name`. */
  name: string;
  quantity: number | null;
  unit: string | null;
  /** Open Food Facts id, or `null` when the lexicon did not resolve the line. */
  foodSlug: string | null;
  /** Which cascade step produced the hit. `miss` is the one that matters here. */
  via: FoodMatch["via"];
  /** `null` for an unresolved line, and for a resolved food that carries no traits. */
  traits: IngredientTraits | null;
}

/** Everything a classifier is handed. Pure input — no database, no network. */
export interface ClassifierInput {
  recipeName: string;
  lines: readonly ClassifierLine[];
}

// --- what a classifier writes ---------------------------------------------

/** FDA Big 9 plus gluten (plan D7). `wheat` and `gluten` are distinct — barley is gluten, not wheat. */
export type AllergenSlug = "milk" | "egg" | "fish" | "crustacean_shellfish" | "tree_nuts" | "peanut" | "wheat" | "soy" | "sesame" | "gluten";

export const ALLERGEN_SLUGS: readonly AllergenSlug[] = ["milk", "egg", "fish", "crustacean_shellfish", "tree_nuts", "peanut", "wheat", "soy", "sesame", "gluten"];

/** Four-state (plan D5). Read the `not_detected` note at the top of this file. */
export type AllergenVerdict = "contains" | "may_contain" | "not_detected" | "unknown";

/** Three-state (plan D6). There is no "certified", and there never will be from rules. */
export type DietVerdict = "excluded" | "likely" | "unknown";

export type Dimension = "allergen" | "diet";

/** One ingredient line that made a verdict what it is. */
export interface EvidenceLine {
  ordinal: number;
  text: string;
  foodSlug: string | null;
}

/**
 * Why a verdict says what it says, stored as the label's `evidence` jsonb.
 *
 * This is what makes a wrong verdict diagnosable instead of mysterious — "this
 * recipe is not vegetarian *because line 7 is fish sauce*" (plan §8.3). It is
 * also the whole reason the dev panel is worth building.
 */
export interface Evidence {
  /** Which rule fired, named so it can be found in the source. */
  rule: string;
  /** The lines that fired it. Empty for a verdict reached from their absence. */
  lines: EvidenceLine[];
  /** Free text where the rule alone does not explain the verdict. */
  note?: string;
}

/** One row of `recipe_enrichment_label`. */
export interface Label {
  dimension: Dimension;
  slug: string;
  verdict: AllergenVerdict | DietVerdict;
  /** 0..1. */
  confidence: number;
  /**
   * Per-label, not per-row, so a later LLM provider can overwrite one recipe's
   * `allergen/sesame` while the rules keep owning the rest (plan §3.2).
   */
  method: string;
  evidence: Evidence;
}

/**
 * A classifier. Pure: same input, same labels, no database and no network.
 *
 * Adding an LLM later is adding one module to the array in `classifiers/index.ts`
 * — that is the entire seam (plan D2). Nothing is stubbed dead into the graph
 * today.
 */
export type Classifier = (input: ClassifierInput) => Label[];
