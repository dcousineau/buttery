/**
 * Vocabulary this workflow's halves exchange: job payloads, the LLM-merge
 * concern (`Disagreement`), and the classifier vocabulary re-exported from
 * `@buttery/food/classify` (and `AllergenSlug`/`ALLERGEN_SLUGS` from
 * `@buttery/food/traits`) now that the classifiers themselves live there —
 * see `packages/food/src/classify.ts`'s module doc for why. This file is a
 * seam, not an owner: everything below is either re-exported from food or is
 * a genuinely pipeline-only concern (the LLM merge).
 */

// --- job payloads ----------------------------------------------------------

/** `enrich`/`llm-enrich` payloads live in `@buttery/pipeline-contract` — the web app enqueues these too. Re-exported so this folder has one place to look. */
export type { EnrichPayload, LlmEnrichPayload } from "@buttery/pipeline-contract";

// --- classifier vocabulary, re-exported from @buttery/food ------------------

import type { Dimension } from "@buttery/food/classify";

export type { AllergenVerdict, Classifier, ClassifierInput, ClassifierLine, Dimension, DietVerdict, EmittedDietSlug, Evidence, EvidenceLine, Label } from "@buttery/food/classify";
export { EMITTED_DIET_SLUGS } from "@buttery/food/classify";

export type { AllergenSlug } from "@buttery/food/traits";
export { ALLERGEN_SLUGS } from "@buttery/food/traits";

// --- LLM-merge concern, pipeline-only ---------------------------------------

/**
 * One place the LLM and the rules reached different verdicts about the same
 * slug, and the rules won. The merge is safety-asymmetric: the LLM may
 * escalate an allergen and may fill an absence, but never talks one down and
 * never overturns a rules `excluded`. Every such attempt is thrown away as a
 * label and kept as one of these, captured to PostHog as an
 * `llm_enrichment_disagreement` event. Carries no ingredient text — recipe id
 * and origin only.
 */
export interface Disagreement {
  dimension: Dimension;
  slug: string;
  /** What the rules row said. `null` where the rules had no row. */
  rulesVerdict: string | null;
  /** What the LLM wanted to say instead. */
  llmVerdict: string;
  llmConfidence: number;
}
