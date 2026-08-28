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

/** Token counts from the AI SDK's `GenerateObjectResult['usage']` — same field names, so a caller can pass `result.usage` straight through without reshaping it. */
export interface GenerationUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}

/**
 * Custom per-token USD pricing, forwarded to PostHog only when the caller
 * supplies it (plan §5.3). PostHog prices well-known models automatically
 * from `$ai_model` + token counts; Kimi may not be in its price table yet,
 * and this is the manual override for that gap. `undefined` fields are
 * simply omitted from the properties object — there is no "send a zero
 * price" state, since a zero price is a real (if unusual) value a caller
 * could mean.
 */
export interface GenerationPricing {
  inputTokenPriceUsd?: number;
  outputTokenPriceUsd?: number;
}

/** What went wrong, when it did. `message` becomes `$ai_error` verbatim — keep it short and free of ingredient text, same redaction discipline as everything else here. */
export interface GenerationError {
  message: string;
}

/**
 * Everything {@link buildGenerationEvent} needs to describe one `llm-enrich`
 * model call (llm plan §10). Assembled by the step after `generateObject`
 * returns (or throws) and the merge (§8) has run — `labelsWritten` and
 * `disagreements` describe the merge's output, not the raw model output, so
 * this input can only be built once both have happened.
 *
 * `messages`/`outputChoices` are typed as opaque `object` arrays rather than
 * imported from the `ai` package's message types: this file has no reason to
 * depend on the AI SDK's shapes, and `$ai_input`/`$ai_output_choices` are
 * PostHog properties that accept whatever JSON-serializable array the caller
 * sends. `classify.ts` passes the AI SDK's own `messages` array and
 * `result.object` wrapped as a one-element choices array straight through.
 *
 * `object` rather than `Record<string, unknown>` for a boring reason worth
 * writing down, because it looks like a weakening and is not: an INTERFACE
 * (which both `ModelMessage` and `classify.ts`'s `LlmOutputChoice` are) has no
 * implicit index signature, so it does not satisfy `Record<string, unknown>`
 * however record-shaped it looks. `object` says exactly what this file needs —
 * "some JSON object, whose keys are none of my business" — and still rejects
 * the array of primitives that a stray `Record` cast would have let through.
 */
export interface GenerationEventInput {
  /** One id per `llm-enrich` run, `crypto.randomUUID()` at the top of the step — groups this generation in PostHog's Traces view. */
  traceId: string;
  /** e.g. `kimi-k2-0905-preview` — `LLM_ENRICHMENT_MODEL` verbatim, not a display name. */
  model: string;
  /** e.g. `moonshot` — `LLM_ENRICHMENT_PROVIDER` verbatim. */
  provider: string;
  /** The provider's base URL, e.g. `https://api.moonshot.ai/v1` — lets a slow/misrouted endpoint show up in the trace without a log dig. */
  baseUrl: string;
  /**
   * Wall-clock time for the `generateObject` call, in **milliseconds** —
   * converted to seconds inside {@link buildGenerationEvent} because that is
   * the unit `$ai_latency` expects.
   */
  latencyMs: number;
  usage: GenerationUsage;
  /**
   * HTTP status of the underlying request, when known. `0` for a failure
   * that never got a response (timeout, network error) — never omitted, so
   * `$ai_http_status` is always present and a dashboard can group on it
   * without a null case.
   */
  httpStatus: number;
  recipeId: string;
  recipeOrigin: RecipeOrigin;
  /**
   * The PostHog Prompt Management prompt name in effect for this call —
   * `prompt-fetch.ts`'s `PROMPT_NAME`, passed in rather than imported so
   * this file has no dependency on that module.
   */
  promptName: string;
  /**
   * The PostHog prompt *version* actually used, or `null` when the fallback
   * in `prompt.ts` served instead (`prompt-fetch.ts`'s contract) — `null` is
   * a real, queryable value, not a placeholder for "unknown" (plan §6.2).
   */
  promptVersion: number | null;
  /** `LLM_ENRICHMENT_VERSION` at the time of this call (schema.ts). */
  llmVersion: number;
  /** How many `Label` rows the merge (§8) actually wrote for this recipe. */
  labelsWritten: number;
  /**
   * How many `Disagreement`s the merge produced for this recipe — a count,
   * not the disagreements themselves (those are separate
   * `llm_enrichment_disagreement` events, one each, via {@link buildDisagreementEvent}).
   */
  disagreements: number;
  /** Ingredient line count the recipe was classified over. */
  lineCount: number;
  /**
   * How many of those lines the rules classifier could not resolve
   * (`foodSlug === null`) — the same denominator `unresolvedShare` in
   * `lib/classifiers/shared.ts` reads, given to the LLM as context and worth
   * correlating against disagreement rate.
   */
  unresolvedLineCount: number;
  /**
   * The messages sent to `generateObject`. Captured to PostHog only for
   * `recipeOrigin === 'sync'` (L10) — see {@link buildGenerationEvent}'s doc
   * comment.
   */
  messages: readonly object[];
  /**
   * The model's output, wrapped as a choices-shaped array (PostHog's
   * `$ai_output_choices` convention) — same `sync`-only redaction as
   * `messages`.
   */
  outputChoices: readonly object[];
  /**
   * Present when the call failed (schema rejection, timeout, provider
   * error) — see the `$ai_is_error`/`$ai_error` properties below. Absent on
   * a clean success.
   */
  error?: GenerationError;
  /**
   * Custom per-token pricing, forwarded when the caller supplies it (plan
   * §5.3). Left undefined by {@link buildGenerationEvent}'s callers in tests
   * that don't care about pricing; {@link sendGenerationEvent} is what
   * actually reads the env vars for the real send path.
   */
  pricing?: GenerationPricing;
}

/**
 * The distinct id every event in this module is captured against — a
 * SERVICE identity, never a user DID (L10, plan §10). Recipe content, even
 * redacted to just tokens/cost, must never be attributable to a person
 * through the distinct id it's filed under.
 */
export const PIPELINE_DISTINCT_ID = "recipe-enrichment-pipeline";

/** PostHog's own event name for a manually-captured LLM generation — the name the Traces/Generations tabs and the evaluations in plan §5.4 key off. */
export const AI_GENERATION_EVENT = "$ai_generation";

/**
 * The `ai_feature` value every `$ai_generation` this module sends carries.
 * Plan §5.4's evaluations are ALL condition-filtered to
 * `ai_feature = 'recipe-llm-enrichment'` — this constant is contractual, the
 * same way `LLM_ENRICHMENT_FLAG` is in `posthog.ts`.
 *
 * This happens to be the same string as `prompt.ts`'s `PROMPT_NAME` (both
 * are `recipe-llm-enrichment`, plan §5.2), which is a deliberate naming
 * choice at the PostHog-artifact level, not a code dependency: this constant
 * is defined independently, not imported from `prompt.ts`, so `capture.ts`
 * never has to know whether that module has landed yet.
 */
export const AI_FEATURE = "recipe-llm-enrichment";

/**
 * Build the `$ai_generation` event for one `llm-enrich` call. Pure — no
 * PostHog client, no `Date.now()`, no randomness; every value it needs is in
 * `input`. This is what `llm/capture.test.ts` exercises directly (plan
 * §12.1); `sendGenerationEvent` below is the only thing standing between
 * this and a real `client.capture()`.
 *
 * **The redaction line (L10, plan §10):** `$ai_input` (the messages sent)
 * and `$ai_output_choices` (the model's output) are attached ONLY when
 * `input.recipeOrigin === 'sync'`. For `'local'` they are omitted from the
 * properties object entirely — not an empty array, not a redacted
 * placeholder string, simply absent as keys, because `expect(props).not.toHaveProperty(...)`
 * is the only assertion that actually proves nothing leaked. The reasoning:
 * recipe content must never be attachable to a person, and a `sync` recipe
 * is public network content that was already fetched from the open web,
 * while a `local` recipe is somebody's own — often hand-typed, sometimes a
 * family dish, sometimes annotated with things they'd never publish. Every
 * OTHER property (tokens, cost, latency, model, http status, the recipe id
 * and every custom property) is sent for `local` generations exactly as for
 * `sync` ones: none of that is recipe content, all of it is needed to see
 * whether the LLM pass is healthy and affordable across the whole corpus,
 * and none of it identifies a person either way (see `PIPELINE_DISTINCT_ID`'s
 * doc comment).
 */
export function buildGenerationEvent(input: GenerationEventInput): { distinctId: string; event: string; properties: Record<string, unknown> } {
  const properties: Record<string, unknown> = {
    $ai_trace_id: input.traceId,
    $ai_span_name: "classify-recipe",
    $ai_model: input.model,
    $ai_provider: input.provider,
    $ai_input_tokens: input.usage.inputTokens,
    $ai_output_tokens: input.usage.outputTokens,
    // Every other timestamp/duration in this codebase's PostHog capture is
    // whatever unit the source value already is in; `$ai_latency` is the one
    // PostHog property that is contractually SECONDS, so the conversion
    // lives right here rather than trusting every future caller to remember it.
    $ai_latency: input.latencyMs / 1000,
    $ai_http_status: input.httpStatus,
    $ai_base_url: input.baseUrl,

    // Custom properties — what flags, evals and dashboards filter on
    // (plan §10). Spellings are contractual; do not rename without checking
    // §5.4's evaluation conditions and any dashboard built on these.
    ai_feature: AI_FEATURE,
    recipe_id: input.recipeId,
    recipe_origin: input.recipeOrigin,
    // PostHog's own convention for prompt provenance on an LLM event, so the
    // Prompt Management UI can tie a generation back to the version that
    // produced it — `$ai_prompt_name`/`$ai_prompt_version` are what
    // `@posthog/ai`'s docs tell you to send from `Prompts.get`'s result.
    // `$ai_prompt_version` is null exactly when the committed fallback ran,
    // which makes "which recipes did NOT run on a managed prompt" one filter.
    $ai_prompt_name: input.promptName,
    $ai_prompt_version: input.promptVersion,
    // The same two under plain names, kept because the §5.4 evaluations and
    // the §5.3 dashboard filter on unprefixed custom properties alongside
    // `ai_feature`, and dropping them would silently break whatever a human
    // has already built on top. Cheap; two strings per generation.
    prompt_name: input.promptName,
    prompt_version: input.promptVersion,
    llm_version: input.llmVersion,
    labels_written: input.labelsWritten,
    disagreements: input.disagreements,
    line_count: input.lineCount,
    unresolved_line_count: input.unresolvedLineCount,
  };

  if (input.error) {
    properties.$ai_is_error = true;
    properties.$ai_error = input.error.message;
  }

  if (input.recipeOrigin === "sync") {
    properties.$ai_input = input.messages;
    properties.$ai_output_choices = input.outputChoices;
  }

  if (input.pricing?.inputTokenPriceUsd !== undefined) {
    properties.$ai_input_token_price = input.pricing.inputTokenPriceUsd;
  }
  if (input.pricing?.outputTokenPriceUsd !== undefined) {
    properties.$ai_output_token_price = input.pricing.outputTokenPriceUsd;
  }

  return { distinctId: PIPELINE_DISTINCT_ID, event: AI_GENERATION_EVENT, properties };
}

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
 * Read the custom-pricing env vars (plan §5.3, §11) and send one
 * `$ai_generation` event for `input`. The only place in this module that
 * reads `process.env` — {@link buildGenerationEvent} stays pure and
 * deterministically testable by taking `pricing` as an explicit input field
 * instead, and this thin wrapper is what fills that field in for the real
 * call path. Fire-and-forget via {@link capture}: never throws, no-ops when
 * PostHog is absent. Synchronous, not `async` — there is no I/O left in this
 * path once the client is already in hand; callers still `await` it, which is
 * harmless on a non-`Promise` return.
 */
export function sendGenerationEvent(client: PostHog | null, log: FastifyBaseLogger, input: Omit<GenerationEventInput, "pricing">): void {
  const inputTokenPriceUsd = envFloat("LLM_INPUT_TOKEN_PRICE_USD");
  const outputTokenPriceUsd = envFloat("LLM_OUTPUT_TOKEN_PRICE_USD");
  const pricing: GenerationPricing | undefined = inputTokenPriceUsd !== undefined || outputTokenPriceUsd !== undefined ? { inputTokenPriceUsd, outputTokenPriceUsd } : undefined;

  const { distinctId, event, properties } = buildGenerationEvent(pricing ? { ...input, pricing } : input);
  capture(client, log, distinctId, event, properties);
}

function envFloat(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : undefined;
}

// --- disagreements -----------------------------------------------------

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

// --- one-call-site wrappers for index.ts's llm-enrich step -----------------

/** The provider/prompt identity a generation event names. */
export interface GenerationProvider {
  providerName: string;
  modelId: string;
  baseURL: string;
}

export interface GenerationPrompt {
  name: string;
  version: number | null;
}

export interface CaptureGenerationInput {
  traceId: string;
  recipeId: string;
  recipeOrigin: RecipeOrigin;
  provider: GenerationProvider;
  prompt: GenerationPrompt;
  lines: readonly ClassifierLine[];
  messages: readonly object[];
  outputChoices: readonly object[];
  usage: GenerationUsage;
  latencyMs: number;
  llmVersion: number;
  writes: readonly Label[];
  disagreements: readonly Disagreement[];
}

/** Send the generation event and one disagreement event per disagreement, for a successful `llm-enrich` call. Synchronous — see {@link sendGenerationEvent}. */
export function captureGeneration(client: PostHog | null, log: FastifyBaseLogger, input: CaptureGenerationInput): void {
  const unresolvedLineCount = input.lines.filter((line) => line.foodSlug === null).length;
  sendGenerationEvent(client, log, {
    traceId: input.traceId,
    model: input.provider.modelId,
    provider: input.provider.providerName,
    baseUrl: input.provider.baseURL,
    latencyMs: input.latencyMs,
    usage: input.usage,
    httpStatus: 200,
    recipeId: input.recipeId,
    recipeOrigin: input.recipeOrigin,
    promptName: input.prompt.name,
    promptVersion: input.prompt.version,
    llmVersion: input.llmVersion,
    labelsWritten: input.writes.length,
    disagreements: input.disagreements.length,
    lineCount: input.lines.length,
    unresolvedLineCount,
    messages: input.messages,
    outputChoices: input.outputChoices,
  });
  for (const disagreement of input.disagreements) {
    sendDisagreementEvent(client, log, { recipeId: input.recipeId, recipeOrigin: input.recipeOrigin, disagreement });
  }
}

export interface CaptureGenerationFailureInput {
  traceId: string;
  recipeId: string;
  recipeOrigin: RecipeOrigin;
  provider: GenerationProvider;
  prompt: GenerationPrompt;
  lines: readonly ClassifierLine[];
  llmVersion: number;
  message: string;
  /** The model's raw text, when the failure was a schema rejection — appended to `message` for `$ai_error`. */
  rawText: string | undefined;
}

/** Send the generation event for a failed `llm-enrich` call — zero counts, `httpStatus: 0`, the error message (plus raw model text, when there is one). Synchronous — see {@link sendGenerationEvent}. */
export function captureGenerationFailure(client: PostHog | null, log: FastifyBaseLogger, input: CaptureGenerationFailureInput): void {
  const unresolvedLineCount = input.lines.filter((line) => line.foodSlug === null).length;
  sendGenerationEvent(client, log, {
    traceId: input.traceId,
    model: input.provider.modelId,
    provider: input.provider.providerName,
    baseUrl: input.provider.baseURL,
    latencyMs: 0,
    usage: { inputTokens: undefined, outputTokens: undefined },
    httpStatus: 0,
    recipeId: input.recipeId,
    recipeOrigin: input.recipeOrigin,
    promptName: input.prompt.name,
    promptVersion: input.prompt.version,
    llmVersion: input.llmVersion,
    labelsWritten: 0,
    disagreements: 0,
    lineCount: input.lines.length,
    unresolvedLineCount,
    messages: [],
    outputChoices: [],
    error: { message: input.rawText ? `${input.message} — raw: ${input.rawText}` : input.message },
  });
}
