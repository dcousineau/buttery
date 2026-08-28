import type { ClassifierInput, Label } from "./classifiers/types.ts";
import { CLASSIFIERS } from "./classifiers/index.ts";
import { RULES_METHOD } from "./classifiers/shared.ts";

/**
 * @buttery/food/classify — rules-based recipe classifiers: allergen and diet
 * verdicts derived from `traits.ts`'s per-food facts plus a small set of text
 * patterns over ingredient lines the lexicon couldn't resolve (plan
 * `2026-08-20-recipe-enrichment.md` §8). Moved here from `services/pipeline`
 * (recipe-enrichment classifiers-to-food plan) because the classifiers are
 * pure functions over exactly the vocabulary `@buttery/food` already owns —
 * `AllergenSlug`, `TriState`, `FoodTraits` — and belong on the same side of
 * the package boundary as that vocabulary, not wherever they were first
 * needed.
 *
 * **SERVER-ONLY**, inherited from `traits.ts` (read its module doc): this
 * module exists to consume traits data, and traits data is a pipeline-only
 * concern. Nothing the client renders should import this module.
 *
 * The pipeline's `recipe-enrichment/index.ts` `enrich` step is the only
 * caller: parse a recipe's ingredient lines, match them against the food
 * lexicon, hand the result to `classify`, and write what comes back. Nothing
 * here touches a database or the network — that split is what makes
 * `classify.test.ts` a plain vitest suite with no fixtures beyond hand-built
 * `ClassifierInput`s.
 *
 * **Never write to `recipe.suitable_for_diet`, `recipe.calories` or the
 * `*_content` columns** (plan D1). Those are what the author declared; this
 * module never reads them either, because a declared diet is not evidence —
 * when a declared diet contradicts a derived verdict, both stand, and what to
 * do about the disagreement is the Randomizer's problem, not this one's.
 */

// `AllergenSlug`/`ALLERGEN_SLUGS`/`TriState` are not re-exported here — they
// live in `traits.ts` (`@buttery/food/traits`) and stay there, so the barrel
// (`index.ts`) never has to reconcile two `export *`s naming the same symbol.
export type { AllergenVerdict, Classifier, ClassifierInput, ClassifierLine, Dimension, DietVerdict, EmittedDietSlug, Evidence, EvidenceLine, Label } from "./classifiers/types.ts";
export { EMITTED_DIET_SLUGS, TRAIT_MAYBE, TRAIT_NO, TRAIT_YES } from "./classifiers/types.ts";

/**
 * Bumped when a rule changes what a verdict would be — including when a slug
 * is added to or removed from either emitted set (`ALLERGEN_SLUGS` in
 * `traits.ts`, `EMITTED_DIET_SLUGS` above). Stored on the pipeline's
 * `recipe_enrichment.classifier_version`.
 *
 * v2: sparse labels (plan follow-up). Deleted the six diet slugs with no rule
 * (`keto`, `low_carb`, `low_fat`, `low_calorie`, `diabetic`, `paleo`) and the
 * halal/kosher `unknown` fallback, and stopped emitting allergen
 * `not_detected` — see `classifiers/README.md`. The bump is what makes every
 * already-classified recipe backfill-eligible: `enrich` deletes and
 * reinserts a recipe's labels each run, so re-running under v2 clears the
 * now-dead rows rather than leaving them stale forever.
 */
export const CLASSIFIER_VERSION = 2;

/** The `method` every rules-derived label carries. Defined in `classifiers/shared.ts` (see there for why) and re-exported so this file has the one name callers need. */
export { RULES_METHOD };

/** Run every classifier in `CLASSIFIERS` and return the union of their labels. */
export function classify(input: ClassifierInput): Label[] {
  return CLASSIFIERS.flatMap((classifier) => classifier(input));
}
