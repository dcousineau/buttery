import { OpenTelemetry } from "@ai-sdk/otel";
import type { Attributes } from "@opentelemetry/api";

/**
 * The per-call half of PostHog AI observability: what one `generateText` call
 * tells OpenTelemetry about itself.
 *
 * `plugins/telemetry.ts` owns the global half (the provider and the PostHog
 * span processor). This module owns the options object handed to a single
 * call, and it exists as a generic helper rather than inline at the call site
 * for the same reason `lib/ai/provider.ts` does: the shape is about the AI SDK,
 * not about recipes, and the next call site should not have to rediscover it.
 *
 * ── PER-CALL INTEGRATION, NOT `runtimeContext` ─────────────────────────────
 *
 * The AI SDK offers two ways to get custom attributes onto a span. PostHog's
 * docs show the global one: register an `OpenTelemetry` integration once with
 * an `enrichSpan` callback, then pass per-call values through
 * `runtimeContext` + `telemetry.includeRuntimeContext`, and have `enrichSpan`
 * read them back out. This module uses the other one —
 * `telemetry.integrations`, documented as taking "precedence over the globally
 * registered integrations for this call" — because it lets `enrichSpan` close
 * over the job's own values directly.
 *
 * That is not just shorter. `@ai-sdk/otel` passes `runtimeContext` to
 * `enrichSpan` for `generateText`/`streamText` but NOT for object generation,
 * and this call site is `generateText` with `Output.object(...)` — near enough
 * to that boundary that relying on it would mean depending on which side of a
 * documented caveat we land. A closure has no such question: the values are in
 * scope, so they are on the span.
 *
 * Verified against an in-memory span exporter (`telemetry.test.ts`): the
 * attributes land on all three spans the SDK emits for one call
 * (`invoke_agent`, `step`, `chat`).
 *
 * ── PROMPT AND OUTPUT TEXT ARE ALWAYS RECORDED ─────────────────────────────
 *
 * `recordInputs`/`recordOutputs` decide whether the prompt and the model's
 * answer become `gen_ai.input.messages` / `gen_ai.output.messages` span
 * attributes. Both are on, unconditionally, for every generation this service
 * makes. An earlier revision made them a function of the recipe's origin —
 * text for `sync` recipes, redaction for `local` ones — and that is gone
 * deliberately: a generation you cannot read the prompt and the answer of is
 * not much of a generation record, and the half of the corpus most worth
 * inspecting (hand-entered recipes, where the model is likeliest to be wrong)
 * was exactly the half being blanked. Origin still rides the span as the
 * `recipe_origin` attribute, so PostHog can slice or filter on it; what it no
 * longer does is decide what gets sent.
 *
 * The whole control is therefore `enabled`: no telemetry provider, no spans,
 * no text. `plugins/telemetry.ts` owns that gate.
 */

/** What one generation tells its span about itself, beyond what the AI SDK records on its own. */
export interface GenerationTelemetryInput {
  /**
   * Skips building any of this when `plugins/telemetry.ts` registered no
   * provider. The spans would go to the API's no-op tracer either way; this
   * just avoids the allocation and makes "telemetry is off" visible at the
   * call site rather than three layers down.
   */
  enabled: boolean;
  /** Groups this generation in PostHog's Traces view. The job's own `traceId`. */
  traceId: string;
  /**
   * PostHog's person key for the resulting event. A SERVICE identity, never a
   * user DID — recipe content must not be attributable to a person. See
   * `PIPELINE_DISTINCT_ID`'s doc comment in
   * `queues/recipe-enrichment/lib/capture.ts`, which is still the constant
   * this is passed.
   */
  distinctId: string;
  /** `telemetry.functionId` — groups generations by call site in the AI SDK's own spans. */
  functionId: string;
  /**
   * Everything else, as OTel attributes. Values that are `null` or `undefined`
   * are dropped rather than sent: OTel `Attributes` has no null, and a
   * stringified `"null"` reaching a PostHog property would be worse than an
   * absent one — `prompt_version` in particular is meaningfully null (the
   * committed fallback prompt ran), and "absent" reads that way where
   * `"null"` would not.
   */
  attributes: Record<string, string | number | boolean | null | undefined>;
}

/** Drop the nullish entries and hand back something OTel will accept. */
function toAttributes(input: Record<string, string | number | boolean | null | undefined>): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Build the `telemetry` option for one `generateText` call.
 *
 * Returns `{ isEnabled: false }` when telemetry is off, which is the AI SDK's
 * own documented opt-out — cheaper and more honest than passing an integration
 * whose spans go nowhere.
 */
export function generationTelemetry(input: GenerationTelemetryInput): {
  isEnabled: boolean;
  recordInputs?: boolean;
  recordOutputs?: boolean;
  functionId?: string;
  integrations?: OpenTelemetry[];
} {
  if (!input.enabled) return { isEnabled: false };

  const attributes = toAttributes({
    ...input.attributes,
    // PostHog reads the person key off this attribute on the OTLP path, the
    // way `distinctId` does on the capture path.
    "posthog.distinct_id": input.distinctId,
    $ai_trace_id: input.traceId,
    $ai_span_name: input.functionId,
  });

  return {
    isEnabled: true,
    // Unconditional — see the module doc comment. Explicit rather than left to
    // the SDK's default so a default change cannot silently blank the corpus.
    recordInputs: true,
    recordOutputs: true,
    functionId: input.functionId,
    // Fires once per span the SDK creates for this call, and returns the same
    // attributes for each — so whichever span PostHog turns into the
    // `$ai_generation`, the properties are on it.
    integrations: [new OpenTelemetry({ enrichSpan: () => attributes })],
  };
}
