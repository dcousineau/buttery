import type { FoodMatch } from "../categorize.ts";
import type { FoodTraits, TriState } from "../traits.ts";

/**
 * Vocabulary `../classify.ts`'s classifiers read and write — internal to the
 * `classifiers/` folder, sibling to `shared.ts`/`allergen.ts`/`diet.ts`/
 * `index.ts` so none of them has to import the public face (`../classify.ts`)
 * just to see its own types. `../classify.ts` re-exports this file wholesale;
 * nothing outside `src/classifiers/` should import it directly.
 *
 * `not_detected` IS NOT A SAFETY CLAIM: it means the rules found nothing over
 * free text they may not have fully parsed. A consumer excludes a recipe on
 * `contains` and `may_contain` only; nothing may present `not_detected` as
 * "free of".
 */

// --- what a classifier reads ----------------------------------------------

/** Open Food Facts' own tri-state (`../traits.ts`'s `TriState`), spelled out as named constants a classifier can compare against without a magic `0`/`1`/`2`. */
export const TRAIT_NO = 0 satisfies TriState;
export const TRAIT_YES = 1 satisfies TriState;
export const TRAIT_MAYBE = 2 satisfies TriState;

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
  traits: FoodTraits | null;
}

/** Everything a classifier is handed. Pure input — no database, no network. */
export interface ClassifierInput {
  recipeName: string;
  lines: readonly ClassifierLine[];
}

// --- what a classifier writes ---------------------------------------------

/** Four-state. Read the `not_detected` note at the top of this file. */
export type AllergenVerdict = "contains" | "may_contain" | "not_detected" | "unknown";

/**
 * LABELS ARE SPARSE — absence is a verdict. A row is written only when it says
 * something the dimension's default does not:
 *
 *   | dimension | absence means  | stored verdicts                      |
 *   | --------- | --------------- | ------------------------------------ |
 *   | allergen  | `not_detected`  | `contains`, `may_contain`, `unknown` |
 *   | diet      | `not excluded`  | `excluded`, `likely`, `unknown`      |
 *
 * `unknown` is still stored for allergens: it means the rules could not read
 * every line, which is a different fact than `not_detected` (read every line,
 * found nothing) — collapsing both into absence would lose that distinction.
 *
 * INVARIANT: absence may be read as the default only for slugs the row's
 * `classifier_version` actually evaluated. Add a slug to either emitted set
 * without bumping `CLASSIFIER_VERSION` and every already-classified recipe
 * silently reports the default for a slug nothing looked at. `../classify.ts`
 * pins the rules' emitted slug sets with a test.
 */

/**
 * Diet slugs the classifier has a rule for. Not the same as the `diet`
 * dimension in the pipeline's `recipe_vocab`, which also carries `keto`,
 * `low_carb`, `low_fat`, `low_calorie`, `diabetic` and `paleo` — those are
 * author-declared tokens the pipeline resolves for `recipe.suitable_for_diet`;
 * the classifier has nothing true to say about them.
 */
export const EMITTED_DIET_SLUGS = ["vegetarian", "vegan", "pescatarian", "dairy_free", "gluten_free", "halal", "kosher"] as const;

export type EmittedDietSlug = (typeof EMITTED_DIET_SLUGS)[number];

/** Three-state. There is no "certified", and there never will be from rules — `halal`/`kosher` emit `excluded` and nothing else. */
export type DietVerdict = "excluded" | "likely" | "unknown";

/**
 * `recipe_vocab` dimensions a label may be filed under. The first two are
 * exclusion-shaped and shared (rules and an LLM both write); the last three
 * are tag-shaped, LLM-only, and carry exactly one stored verdict (`likely`).
 */
export type Dimension = "allergen" | "diet" | "cuisine" | "meal_type" | "spice_level";

/** One ingredient line that made a verdict what it is. */
export interface EvidenceLine {
  ordinal: number;
  text: string;
  foodSlug: string | null;
}

/** Why a verdict says what it says, stored as the label's `evidence` jsonb — what makes a wrong verdict diagnosable instead of mysterious. */
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
  /** Per-label, not per-row, so a second provider (e.g. an LLM) can overwrite one recipe's `allergen/sesame` while rules keep owning the rest. */
  method: string;
  evidence: Evidence;
}

/** A classifier. Pure: same input, same labels, no database and no network. */
export type Classifier = (input: ClassifierInput) => Label[];
