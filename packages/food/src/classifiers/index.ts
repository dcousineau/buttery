import type { Classifier } from "./types.ts";
import { allergenClassifier } from "./allergen.ts";
import { dietClassifier } from "./diet.ts";

/**
 * The ordered classifier array — this line is the entire LLM seam (plan D2).
 * Adding an LLM later means adding one module here; nothing today is dead or
 * stubbed to make room for it. `../classify.ts` runs every entry and unions
 * their labels, so order only matters for the evidence a reader sees first
 * when two classifiers happen to disagree about the same (dimension, slug) —
 * which cannot happen yet, since `allergenClassifier` and `dietClassifier`
 * own disjoint dimensions, but will once a second provider for the same
 * dimension lands.
 */
export const CLASSIFIERS: readonly Classifier[] = [allergenClassifier, dietClassifier];
