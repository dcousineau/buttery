import type { ClassifierInput, Label } from "#/workflows/recipe-enrichment/types.ts";
import { CLASSIFIERS } from "#/workflows/recipe-enrichment/classifiers/index.ts";
import { RULES_METHOD } from "#/workflows/recipe-enrichment/classifiers/shared.ts";

/**
 * Pure composition root for the recipe-enrichment classifiers (plan §8).
 * `steps.ts`'s `enrich` step is the only caller: parse a recipe's ingredient
 * lines, match them against the food lexicon, hand the result to `classify`,
 * and write what comes back. Nothing here touches a database or the network —
 * that split is what makes `classify.test.ts` a plain vitest suite with no
 * fixtures beyond hand-built `ClassifierInput`s.
 *
 * **Never write to `recipe.suitable_for_diet`, `recipe.calories` or the
 * `*_content` columns** (plan D1). Those are what the author declared; this
 * module never reads them either, because a declared diet is not evidence —
 * when a declared diet contradicts a derived verdict, both stand, and what to
 * do about the disagreement is the Randomizer's problem, not this one's.
 */

/** Bumped when a rule changes what a verdict would be. Stored on `recipe_enrichment.classifier_version`. */
export const CLASSIFIER_VERSION = 1;

/** The `method` every rules-derived label carries. Defined in `classifiers/shared.ts` (see there for why) and re-exported so this file has the one name `steps.ts` needs. */
export { RULES_METHOD };

/** Run every classifier in `CLASSIFIERS` and return the union of their labels. */
export function classify(input: ClassifierInput): Label[] {
  return CLASSIFIERS.flatMap((classifier) => classifier(input));
}
