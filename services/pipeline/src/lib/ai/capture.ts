import type { PostHog } from "posthog-node";

/**
 * The generic half of `$ai_generation` capture, extracted here for
 * `plugins/ai.ts` (S1) from `workflows/recipe-enrichment/lib/capture.ts` —
 * the original stays in place, unchanged, and keeps serving
 * `recipe-enrichment/index.ts`.
 *
 * This is deliberately a much smaller surface than the source file: only the
 * properties that describe an LLM call itself (model, provider, tokens,
 * latency, http status, prompt identity, pricing, error) live here. Anything
 * that knows what a *recipe* is — `recipe_id`, `recipe_origin`,
 * `labels_written`, `disagreements`, `line_count`, `unresolved_line_count`,
 * the `ai_feature`/`prompt_name`/`prompt_version` plain-name duplicates, the
 * disagreement event, the `captureGeneration`/`captureGenerationFailure`
 * wrappers — is recipe-enrichment domain knowledge and stays workflow-owned
 * in the source file. A caller that wants those fields in the event passes
 * them through {@link AiGenerationEventInput.properties}, which is merged in
 * verbatim; this module never inspects or names any of them.
 */

/** Token counts from the AI SDK's `GenerateObjectResult`/`GenerateTextResult['usage']` — same field names, so a caller can pass `result.usage` straight through without reshaping it. */
export interface AiGenerationUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}

/** Custom per-token USD pricing, forwarded to PostHog only when the caller supplies it. `undefined` fields are simply omitted — there is no "send a zero price" state. */
export interface AiGenerationPricing {
  inputTokenPriceUsd?: number;
  outputTokenPriceUsd?: number;
}

/** What went wrong, when it did. `message` becomes `$ai_error` verbatim. */
export interface AiGenerationError {
  message: string;
}

export interface AiGenerationEventInput {
  /** The PostHog distinct id this event is captured against — a caller decision, since only the caller knows what identity (service, workflow) the event belongs to. */
  distinctId: string;
  /** Groups this generation in PostHog's Traces view. */
  traceId: string;
  /** e.g. `classify-recipe` — PostHog's `$ai_span_name`. */
  spanName: string;
  /** `ResolvedProvider.modelId` verbatim, not a display name. */
  model: string;
  /** `ResolvedProvider.providerName` verbatim. */
  provider: string;
  /** `ResolvedProvider.baseURL` — lets a slow/misrouted endpoint show up in the trace without a log dig. */
  baseUrl: string;
  /** Wall-clock time for the model call, in **milliseconds** — converted to seconds inside {@link buildAiGenerationEvent} because that is the unit `$ai_latency` expects. */
  latencyMs: number;
  usage: AiGenerationUsage;
  /** HTTP status of the underlying request, when known. `0` for a failure that never got a response. */
  httpStatus: number;
  /** The PostHog Prompt Management prompt name in effect for this call. */
  promptName: string;
  /** The PostHog prompt *version* actually used, or `null` when a fallback served instead. */
  promptVersion: number | null;
  /** The messages sent to the model — a caller redacts this to `undefined` when the content must not reach PostHog. */
  messages?: readonly object[];
  /** The model's output, wrapped as a choices-shaped array (PostHog's `$ai_output_choices` convention) — same redaction discretion as `messages`. */
  outputChoices?: readonly object[];
  /** Present when the call failed (schema rejection, timeout, provider error). */
  error?: AiGenerationError;
  pricing?: AiGenerationPricing;
  /** Caller-owned extra properties (e.g. a recipe-enrichment workflow's `recipe_id`/`labels_written`), merged into the event verbatim. This module does not look at any of these keys. */
  properties?: Record<string, unknown>;
}

/** PostHog's own event name for a manually-captured LLM generation. */
export const AI_GENERATION_EVENT = "$ai_generation";

/**
 * Build the `$ai_generation` event for one model call. Pure — no PostHog
 * client, no `Date.now()`, no randomness; every value it needs is in
 * `input`.
 */
export function buildAiGenerationEvent(input: AiGenerationEventInput): { distinctId: string; event: string; properties: Record<string, unknown> } {
  const properties: Record<string, unknown> = {
    $ai_trace_id: input.traceId,
    $ai_span_name: input.spanName,
    $ai_model: input.model,
    $ai_provider: input.provider,
    $ai_input_tokens: input.usage.inputTokens,
    $ai_output_tokens: input.usage.outputTokens,
    // `$ai_latency` is contractually SECONDS.
    $ai_latency: input.latencyMs / 1000,
    $ai_http_status: input.httpStatus,
    $ai_base_url: input.baseUrl,
    $ai_prompt_name: input.promptName,
    $ai_prompt_version: input.promptVersion,
    ...input.properties,
  };

  if (input.error) {
    properties.$ai_is_error = true;
    properties.$ai_error = input.error.message;
  }

  if (input.messages) {
    properties.$ai_input = input.messages;
  }
  if (input.outputChoices) {
    properties.$ai_output_choices = input.outputChoices;
  }

  if (input.pricing?.inputTokenPriceUsd !== undefined) {
    properties.$ai_input_token_price = input.pricing.inputTokenPriceUsd;
  }
  if (input.pricing?.outputTokenPriceUsd !== undefined) {
    properties.$ai_output_token_price = input.pricing.outputTokenPriceUsd;
  }

  return { distinctId: input.distinctId, event: AI_GENERATION_EVENT, properties };
}

/**
 * Send the event built by {@link buildAiGenerationEvent}. Fire-and-forget and
 * never throws — a capture failure must never fail the caller's job. A total
 * no-op when `client` is `null`, which is the common case in every
 * environment without PostHog enabled.
 *
 * Synchronous: `client.capture()` itself queues the event and returns
 * immediately, so there is nothing here to `await`. A caller may still
 * `await` this call — that stays harmless — but nothing requires it.
 */
export function captureAiGeneration(client: PostHog | null, input: AiGenerationEventInput): void {
  if (!client) return;
  const { distinctId, event, properties } = buildAiGenerationEvent(input);
  try {
    client.capture({ distinctId, event, properties });
  } catch {
    // fire-and-forget: the DB write this reports on already happened.
  }
}
