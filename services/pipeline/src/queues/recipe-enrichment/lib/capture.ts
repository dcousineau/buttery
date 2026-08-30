import type { PostHog } from "posthog-node";
import type { FastifyBaseLogger } from "fastify";
import type { ClassifierLine, Disagreement, Label } from "#/queues/recipe-enrichment/types.ts";

/**
 * Observability capture for `llm-enrich` — manual `$ai_generation` events via
 * `posthog-node` (llm plan L7, §10).
 *
 * **Manual, not `@posthog/ai`.** PostHog ships an OTel span processor
 * (`@posthog/ai`) that wraps the Vercel AI SDK and emits `$ai_generation`
 * automatically. This module does not use it, on purpose (L7): that
 * integration pins its own OTel dependency stack — a tracer provider, span
 * exporters, the works — into a worker that otherwise has none, for a job
 * type that runs one generation per `llm-enrich` invocation and gets nothing
 * from distributed tracing. It also couples the capture layer to whichever
 * AI SDK major `@posthog/ai`'s OTel support happens to track, which is
 * exactly the kind of transitive-version coupling `provider.ts`'s registry
 * seam is built to avoid elsewhere in this folder. A hand-built properties
 * object and one `client.capture()` call get the same event shape for a
 * fraction of the dependency weight, and — the point of this file — a pure
 * function agents can test without any of it running.
 *
 * The heart of this module is {@link buildGenerationEvent}: pure, no I/O, no
 * PostHog client. `send*` wrappers below are the only impure code here, and
 * they do nothing but hand the pure functions' output to this file's own
 * fire-and-forget `capture` helper, which never throws (plan §9.2 step 7).
 * The client itself is `plugins/posthog.ts`'s now — every exported function
 * here takes it as a leading parameter rather than reaching for one itself.
 * If PostHog is absent (`client` is `null`), capture is a total no-op — the
 * `writeLlmEnrichment` DB write already happened by the time `llm-enrich`
 * calls any function in this file, so observability failing here costs
 * nothing load-bearing (plan §10).
 */

// --- shared vocabulary -------------------------------------------------

/**
 * Where the recipe came from — the same two-value distinction the backfill
 * script's `--local-only` and every `origin = 'local'` SQL predicate in
 * `lib/load.ts` use, spelled as a type here because this is the one file in
 * `lib/` that has to branch on it (L10). Not imported from
 * anywhere: nothing in this codebase centralizes it as a shared type today
 * (the db layer just carries `origin: string`), so this is that type's first
 * appearance, and the natural place for it given L10 is this module's whole
 * reason for existing.
 */
export type RecipeOrigin = "sync" | "local";

/**
 * The distinct id every event in this module is captured against — a
 * SERVICE identity, never a user DID (L10, plan §10). Recipe content, even
 * redacted to just tokens/cost, must never be attributable to a person
 * through the distinct id it's filed under.
 *
 * Still the constant the OTel path uses too: `lib/ai/telemetry.ts` puts it on
 * the span as `posthog.distinct_id`, so a generation and its domain events
 * land against the same person key however they reach PostHog.
 */
export const PIPELINE_DISTINCT_ID = "recipe-enrichment-pipeline";

/**
 * The `ai_feature` value every event from this LLM pass carries — the
 * generation span (via `lib/ai/telemetry.ts`) and the domain events below.
 * Plan §5.4's evaluations are ALL condition-filtered to
 * `ai_feature = 'recipe-llm-enrichment'`, so this constant is contractual.
 *
 * This happens to be the same string as `prompt.ts`'s `PROMPT_NAME`, which is
 * a deliberate naming choice at the PostHog-artifact level, not a code
 * dependency: it is defined independently rather than imported.
 */
export const AI_FEATURE = "recipe-llm-enrichment";

/**
 * Fire one event at `client`, fire-and-forget: never throws, no-ops when
 * `client` is `null` (PostHog absent). What `lib/posthog.ts`'s `captureEvent`
 * used to do once it had resolved its own module-scope client — now that the
 * client is `plugins/posthog.ts`'s, callers hand it in instead.
 */
function capture(client: PostHog | null, log: FastifyBaseLogger, distinctId: string, event: string, properties: Record<string, unknown>): void {
  if (!client) return;
  try {
    client.capture({ distinctId, event, properties });
  } catch (err) {
    log.warn({ err: String(err) }, `llm posthog capture failed: ${event}`);
  }
}

/**
 * What {@link buildDisagreementEvent} needs: the recipe identity plus one
 * `Disagreement` from `merge.ts` (§8). One event per disagreement — a recipe
 * with three disagreeing slugs sends three of these, not one with an array.
 */
export interface DisagreementEventInput {
  recipeId: string;
  recipeOrigin: RecipeOrigin;
  disagreement: Disagreement;
}

/** PostHog's event name for one rules-vs-LLM disagreement (plan §8, §5.4, §5.5) — the raw feed for the judge evaluations and the goldens dataset. */
export const DISAGREEMENT_EVENT = "llm_enrichment_disagreement";

/**
 * Build the `llm_enrichment_disagreement` event for one {@link Disagreement}.
 * Pure, same shape of guarantee as {@link buildGenerationEvent}.
 *
 * Carries recipe id, origin, and the `Disagreement` fields verbatim
 * (`dimension`, `slug`, `rulesVerdict`, `llmVerdict`, `llmConfidence`) —
 * **no ingredient text**. This falls out of `Disagreement`'s own shape
 * (`types.ts`) rather than needing separate redaction logic here: the type
 * has no `evidence`, no line text, nothing an ingredient could leak through
 * — the same "no ingredient text" line the type's doc comment states is
 * enforced by construction, not by this function remembering to strip
 * anything.
 */
export function buildDisagreementEvent(input: DisagreementEventInput): { distinctId: string; event: string; properties: Record<string, unknown> } {
  const { disagreement } = input;
  const properties: Record<string, unknown> = {
    recipe_id: input.recipeId,
    recipe_origin: input.recipeOrigin,
    dimension: disagreement.dimension,
    slug: disagreement.slug,
    rules_verdict: disagreement.rulesVerdict,
    llm_verdict: disagreement.llmVerdict,
    llm_confidence: disagreement.llmConfidence,
  };
  return { distinctId: PIPELINE_DISTINCT_ID, event: DISAGREEMENT_EVENT, properties };
}

/**
 * Thin send for one disagreement — builds via {@link buildDisagreementEvent}
 * and hands it to {@link capture}, fire-and-forget. `llm-enrich` calls this
 * once per `Disagreement` the merge produced (plan §9.2 step 7).
 */
export function sendDisagreementEvent(client: PostHog | null, log: FastifyBaseLogger, input: DisagreementEventInput): void {
  const { distinctId, event, properties } = buildDisagreementEvent(input);
  capture(client, log, distinctId, event, properties);
}

// --- domain events: what the generation span cannot say -------------------

/**
 * Two events that exist because the native OTel path moved the generation
 * itself out of our hands, and two things did not come with it.
 *
 * **The merge counts are too late for the span.** `labels_written` and
 * `disagreements` describe what `mergeLlmLabels` produced, which only exists
 * AFTER `generateText` has returned — and `enrichSpan` fires when a span is
 * CREATED. There is no hook that runs late enough. So the pre-call facts
 * (recipe, prompt, model, line counts) ride the generation span, and the
 * post-merge outcome rides {@link ENRICHMENT_COMPLETED_EVENT}, keyed by the
 * same `$ai_trace_id` so the two join in PostHog. The alternative — dropping
 * them — would have cost the only numbers that say whether the LLM pass is
 * doing anything useful.
 *
 * **A schema rejection is not a failed generation.** This is the sharper half.
 * The old hand-rolled path emitted one `$ai_generation` with `$ai_is_error`
 * for ANY throw, including `NoObjectGeneratedError`. On the native path that
 * splits, and the split is more truthful than what it replaced:
 *
 *   - A transport failure (timeout, network, 4xx/5xx) happens inside
 *     `doGenerate`, so the AI SDK's own span records the error and PostHog
 *     gets a properly errored generation for free. Nothing here to do.
 *   - A schema rejection happens ABOVE the model layer: `doGenerate`
 *     succeeded, the tokens were spent, and only then did the output fail to
 *     parse. The generation span records a success, because a success is what
 *     it was.
 *
 * That is more accurate but it retires the `$ai_is_error` signal any dashboard
 * built on it was reading, so {@link ENRICHMENT_FAILED_EVENT} carries it
 * instead — same trace id, the error message, and the model's raw text when
 * there is one. Deliberately NOT a second `$ai_generation`: one model call
 * must not become two generations in the cost and volume numbers.
 */

/** The provider identity the domain events name. Kept as a type because `index.ts` passes `resolveProvider()`'s result straight through. */
export interface GenerationProvider {
  providerName: string;
  modelId: string;
  baseURL: string;
}

export interface GenerationPrompt {
  name: string;
  version: number | null;
}

/** Emitted once per successful `llm-enrich`, carrying what the merge produced. */
export const ENRICHMENT_COMPLETED_EVENT = "llm_enrichment_completed";

/** Emitted when the job failed AFTER the model answered — chiefly a schema rejection. See this section's doc comment. */
export const ENRICHMENT_FAILED_EVENT = "llm_enrichment_failed";

export interface EnrichmentCompletedInput {
  traceId: string;
  recipeId: string;
  recipeOrigin: RecipeOrigin;
  provider: GenerationProvider;
  prompt: GenerationPrompt;
  lines: readonly ClassifierLine[];
  llmVersion: number;
  writes: readonly Label[];
  disagreements: readonly Disagreement[];
}

/** Pure builder, so the property names are testable without a client. */
export function buildEnrichmentCompletedEvent(input: EnrichmentCompletedInput): { distinctId: string; event: string; properties: Record<string, unknown> } {
  return {
    distinctId: PIPELINE_DISTINCT_ID,
    event: ENRICHMENT_COMPLETED_EVENT,
    properties: {
      // The join key: same trace as the generation span this describes.
      $ai_trace_id: input.traceId,
      ai_feature: AI_FEATURE,
      recipe_id: input.recipeId,
      recipe_origin: input.recipeOrigin,
      prompt_name: input.prompt.name,
      prompt_version: input.prompt.version,
      llm_version: input.llmVersion,
      model: `${input.provider.providerName}:${input.provider.modelId}`,
      // The two the span could not carry.
      labels_written: input.writes.length,
      disagreements: input.disagreements.length,
      line_count: input.lines.length,
      unresolved_line_count: input.lines.filter((line) => line.foodSlug === null).length,
    },
  };
}

/** Send the completion event and one disagreement event per disagreement. Fire-and-forget: a capture failure may never fail a job. */
export function captureEnrichmentCompleted(client: PostHog | null, log: FastifyBaseLogger, input: EnrichmentCompletedInput): void {
  const { distinctId, event, properties } = buildEnrichmentCompletedEvent(input);
  capture(client, log, distinctId, event, properties);
  for (const disagreement of input.disagreements) {
    sendDisagreementEvent(client, log, { recipeId: input.recipeId, recipeOrigin: input.recipeOrigin, disagreement });
  }
}

export interface EnrichmentFailedInput {
  traceId: string;
  recipeId: string;
  recipeOrigin: RecipeOrigin;
  provider: GenerationProvider;
  prompt: GenerationPrompt;
  llmVersion: number;
  message: string;
  /** The model's raw text when the failure was a schema rejection — `undefined` for anything else. */
  rawText: string | undefined;
}

/** Pure builder, same reasoning as {@link buildEnrichmentCompletedEvent}. */
export function buildEnrichmentFailedEvent(input: EnrichmentFailedInput): { distinctId: string; event: string; properties: Record<string, unknown> } {
  const properties: Record<string, unknown> = {
    $ai_trace_id: input.traceId,
    ai_feature: AI_FEATURE,
    recipe_id: input.recipeId,
    recipe_origin: input.recipeOrigin,
    prompt_name: input.prompt.name,
    prompt_version: input.prompt.version,
    llm_version: input.llmVersion,
    model: `${input.provider.providerName}:${input.provider.modelId}`,
    error: input.message,
    // Whether the model answered at all is the useful distinction here: raw
    // text present means it did and the output failed to parse (tokens spent,
    // generation span green); absent means it never got that far.
    schema_rejection: input.rawText !== undefined,
  };
  // The raw text is the model's OUTPUT, not the recipe — it is what the model
  // said, which is exactly what someone debugging a rejection needs, and it
  // exists only on the parse-failure path.
  if (input.rawText !== undefined) properties.raw_output = input.rawText;
  return { distinctId: PIPELINE_DISTINCT_ID, event: ENRICHMENT_FAILED_EVENT, properties };
}

/** Send the failure event. Fire-and-forget. */
export function captureEnrichmentFailed(client: PostHog | null, log: FastifyBaseLogger, input: EnrichmentFailedInput): void {
  const { distinctId, event, properties } = buildEnrichmentFailedEvent(input);
  capture(client, log, distinctId, event, properties);
}
