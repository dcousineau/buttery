/**
 * Thin re-export seam: the classifiers themselves moved to
 * `@buttery/food/classify` (recipe-enrichment classifiers-to-food plan) — see
 * that module's doc for why. This file exists only so `../index.ts`'s
 * `import { CLASSIFIER_VERSION, classify } from "#/workflows/recipe-enrichment/lib/classify.ts"`
 * keeps resolving without touching `index.ts`. Safe to delete once whoever
 * owns `index.ts` next repoints that import straight at `@buttery/food/classify`.
 */
export { classify, CLASSIFIER_VERSION, RULES_METHOD } from "@buttery/food/classify";
