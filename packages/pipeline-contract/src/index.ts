/**
 * Contract between whoever enqueues recipe enrichment and the workflow that
 * drains it — queue name, step names, payload shapes — so a rename on one
 * side is a type error on the other, not a silently-ignored job.
 *
 * Zero runtime deps on purpose: this is the one module `@buttery/web` is
 * allowed to import from the pipeline's world.
 */

/** BullMQ queue name for the workflow. Also the `/jobs/:queue` URL segment. */
export const RECIPE_ENRICHMENT_QUEUE = "recipe-enrichment";

/** Classify one recipe with the rules classifier. The workflow's entry step. */
export const ENRICH_STEP = "enrich";

/** Second opinion: ask an LLM to judge what the rules classifier missed. Flag-gated, fail-closed. */
export const LLM_ENRICH_STEP = "llm-enrich";

/** Every step name, in one frozen object, so neither side can drift from the other's spelling. */
export const RECIPE_ENRICHMENT_STEPS = Object.freeze({
  enrich: ENRICH_STEP,
  llmEnrich: LLM_ENRICH_STEP,
});

export type RecipeEnrichmentStep = (typeof RECIPE_ENRICHMENT_STEPS)[keyof typeof RECIPE_ENRICHMENT_STEPS];

/** Payload for the `enrich` step. */
export interface EnrichPayload {
  recipeId: string;
  /** Reclassify even if the content hash and classifier version already match. */
  force?: boolean;
}

/**
 * Deterministic BullMQ job id for `enrich`, so two triggers for the same
 * recipe collapse into one job instead of racing.
 *
 * Recipe ids are atproto rkeys and may contain `:` — and BullMQ's custom-id
 * validation throws on a `:`-containing id that isn't exactly 3 `:`-separated
 * parts. Hence `_` as separator, plus `encodeURIComponent` for belt and
 * suspenders.
 */
export function enrichJobId(recipeId: string): string {
  return `enrich_${encodeURIComponent(recipeId)}`;
}

/** Payload for the `llm-enrich` step. Mirrors {@link EnrichPayload}. */
export interface LlmEnrichPayload {
  recipeId: string;
  /** Re-run even when the content hash and `llm_version` already match. */
  force?: boolean;
}

/** Deterministic BullMQ job id for `llm-enrich` — see {@link enrichJobId} for the `_`/encoding rationale. */
export function llmEnrichJobId(recipeId: string): string {
  return `llm-enrich_${encodeURIComponent(recipeId)}`;
}
