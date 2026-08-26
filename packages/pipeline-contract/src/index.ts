/**
 * The contract between whoever enqueues recipe enrichment and the workflow that
 * drains it — the queue name, the step names, and the payload shape — so a rename
 * on one side cannot leave the other silently talking to nobody. `queue.add`
 * succeeds even when nothing ever reads the queue it names; importing this from
 * both `@buttery/web` and `@buttery/pipeline` instead of restating the string in
 * each is what turns that failure mode into a type error at the call site.
 *
 * Zero runtime dependencies on purpose: this is the one module the web app is
 * allowed to import from the pipeline's world, so it must never drag in `bullmq`,
 * a database client, or anything else that belongs to the worker.
 */

/** BullMQ queue name for the workflow. Also the `/jobs/:queue` URL segment. */
export const RECIPE_ENRICHMENT_QUEUE = "recipe-enrichment";

/** Classify one recipe. The workflow's entry step. */
export const ENRICH_STEP = "enrich";
/** Claim a batch of stale/outdated recipes and fan them out as `enrich` children. */
export const BACKFILL_STEP = "backfill";
/** Fold a `backfill` run's children and log how many candidates remain. */
export const BACKFILL_REPORT_STEP = "backfill-report";

/**
 * A second label provider on the same queue: after the rules classifier writes,
 * `llm-enrich` asks a model to read the lines the lexicon missed and to judge
 * the dimensions no rule covers. Flag-gated and fail-closed — see the workflow's
 * `llm/posthog.ts`.
 *
 * These names live here for the same reason the rules trio's do: the step name
 * is a string BullMQ will happily accept from anyone, and the one place both
 * sides can agree on its spelling is a module they both import.
 */
export const LLM_ENRICH_STEP = "llm-enrich";
/** Claim a batch of recipes whose LLM pass is missing, errored, or behind `LLM_ENRICHMENT_VERSION`. */
export const LLM_BACKFILL_STEP = "llm-backfill";
/** Fold an `llm-backfill` run's children and log how many candidates remain. */
export const LLM_BACKFILL_REPORT_STEP = "llm-backfill-report";

/** Every step name, in one frozen object, so neither side can drift from the other's spelling. */
export const RECIPE_ENRICHMENT_STEPS = Object.freeze({
  enrich: ENRICH_STEP,
  backfill: BACKFILL_STEP,
  backfillReport: BACKFILL_REPORT_STEP,
  llmEnrich: LLM_ENRICH_STEP,
  llmBackfill: LLM_BACKFILL_STEP,
  llmBackfillReport: LLM_BACKFILL_REPORT_STEP,
});

export type RecipeEnrichmentStep = (typeof RECIPE_ENRICHMENT_STEPS)[keyof typeof RECIPE_ENRICHMENT_STEPS];

/** Payload for the `enrich` step. */
export interface EnrichPayload {
  recipeId: string;
  /** Reclassify even if the content hash and classifier version already match. */
  force?: boolean;
}

/**
 * A deterministic BullMQ job id for `enrich`, so two triggers for the same
 * recipe (a save and a concurrent sync sweep, say) collapse into one job instead
 * of racing (plan D14).
 *
 * Recipe ids are atproto rkeys and may contain `-`, `.`, `_`, `:` and `~` (up to
 * 512 chars — AGENTS.md), so this may not shape-validate or regex them. But
 * BullMQ's `Job.validateOptions` (`node_modules/bullmq/dist/esm/classes/job.js`)
 * throws `Custom Id cannot contain :` whenever a custom `jobId` contains `:` and
 * does not split into exactly 3 `:`-separated parts — a compatibility carve-out
 * for its own repeatable-job ids, not something a recipe id would reliably land
 * on. A prefix of `enrich:` alone already adds one colon, so `` `enrich:${recipeId}` ``
 * throws for almost every id (confirmed against that exact check) and prefixing
 * the *encoded* id changes nothing, since `encodeURIComponent` never removes the
 * prefix's own colon. So the prefix separator here is `_`, not `:`, and the
 * recipe id is `encodeURIComponent`-escaped besides — belt and suspenders against
 * any `:` the id itself carries.
 */
export function enrichJobId(recipeId: string): string {
  return `enrich_${encodeURIComponent(recipeId)}`;
}

// --- the LLM second opinion (llm-enrichment plan §4) ----------------------

/** Payload for the `llm-enrich` step. Mirrors {@link EnrichPayload} — same recipe, same force semantics. */
export interface LlmEnrichPayload {
  recipeId: string;
  /**
   * Re-run the LLM pass even when the content hash and `llm_version` already
   * match. Also what makes a `skipped` row (the flag said no last time) a
   * candidate again.
   */
  force?: boolean;
}

/**
 * A deterministic BullMQ job id for `llm-enrich`, so an `enrich` handoff and a
 * concurrent `llm-backfill` claim for the same recipe collapse into one job.
 *
 * `_` separator and `encodeURIComponent`, for exactly the reasons {@link enrichJobId}
 * spells out — read that doc comment before touching either. The prefix differs
 * so the two steps' jobs never collide on one id.
 */
export function llmEnrichJobId(recipeId: string): string {
  return `llm-enrich_${encodeURIComponent(recipeId)}`;
}
