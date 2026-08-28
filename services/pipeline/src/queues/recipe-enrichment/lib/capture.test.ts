import { describe, expect, it, vi } from "vitest";
import type { PostHog } from "posthog-node";
import type { FastifyBaseLogger } from "fastify";
import {
  AI_FEATURE,
  buildDisagreementEvent,
  buildEnrichmentCompletedEvent,
  buildEnrichmentFailedEvent,
  captureEnrichmentCompleted,
  captureEnrichmentFailed,
  DISAGREEMENT_EVENT,
  ENRICHMENT_COMPLETED_EVENT,
  ENRICHMENT_FAILED_EVENT,
  PIPELINE_DISTINCT_ID,
} from "#/queues/recipe-enrichment/lib/capture.ts";
import type { EnrichmentCompletedInput, EnrichmentFailedInput, GenerationProvider, GenerationPrompt } from "#/queues/recipe-enrichment/lib/capture.ts";
import type { ClassifierLine, Disagreement, Label } from "#/queues/recipe-enrichment/types.ts";

/**
 * What this suite covers now that the generation itself moved off
 * `posthog-node` and onto PostHog's native OTel path
 * (`docs/plans/2026-08-28-posthog-native-ai-observability.md`):
 *
 * - {@link buildDisagreementEvent} / {@link sendDisagreementEvent} — unchanged,
 *   still the raw feed for the judge evaluations and the goldens dataset, so
 *   every case that pinned its shape stays.
 * - {@link buildEnrichmentCompletedEvent} / {@link captureEnrichmentCompleted} —
 *   NEW. The merge outcome (`labels_written`, `disagreements`, `line_count`,
 *   `unresolved_line_count`) is computed AFTER `generateText` returns, but
 *   `enrichSpan` (`lib/ai/telemetry.ts`) fires when the span is CREATED — so
 *   these counts cannot ride the generation span and get their own event
 *   instead, joined back to it by `$ai_trace_id`.
 * - {@link buildEnrichmentFailedEvent} / {@link captureEnrichmentFailed} — NEW.
 *   A schema rejection (`NoObjectGeneratedError`) happens ABOVE the model
 *   layer: `doGenerate` already succeeded, so the AI SDK's own generation span
 *   records a SUCCESS, truthfully — tokens were spent, the model answered. The
 *   old `$ai_is_error` signal that dashboard built on it would otherwise lose
 *   is preserved here instead, on a separate domain event, so one model call
 *   never becomes two generations in the volume/cost numbers.
 *
 * What is gone and NOT replaced here: `buildGenerationEvent`,
 * `sendGenerationEvent`, `captureGeneration`, `captureGenerationFailure`,
 * `GenerationEventInput`, `AI_GENERATION_EVENT`. Those built and sent
 * `$ai_generation` by hand; the AI SDK's own OTel spans do that job now
 * (`lib/ai/telemetry.ts`, `lib/ai/telemetry.test.ts` — including the §4
 * redaction proof that used to live in this file's now-deleted
 * `content redaction is origin-gated` cases). This repo's convention is that
 * tests serve the implementation, not the reverse: code for a deleted event
 * gets its tests deleted along with it, not bent to keep passing.
 */

function fakeLog(): FastifyBaseLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
}

function fakeClient(): { client: PostHog; capture: ReturnType<typeof vi.fn> } {
  const capture = vi.fn();
  return { client: { capture } as unknown as PostHog, capture };
}

/** The `event` name `capture` was called with on its Nth call — a named helper so call sites don't chain `?.[0]` into a property read. */
function eventNameAt(capture: ReturnType<typeof vi.fn>, index: number): string {
  const call = capture.mock.calls[index] as [{ event: string }] | undefined;
  if (!call) throw new Error(`capture was not called a ${index + 1}th time`);
  return call[0].event;
}

function fakeProvider(overrides: Partial<GenerationProvider> = {}): GenerationProvider {
  return { providerName: "moonshot", modelId: "kimi-k2-0905-preview", baseURL: "https://api.moonshot.ai/v1", ...overrides };
}

function fakePrompt(overrides: Partial<GenerationPrompt> = {}): GenerationPrompt {
  return { name: "recipe-llm-enrichment", version: 3, ...overrides };
}

function fakeLine(overrides: Partial<ClassifierLine> = {}): ClassifierLine {
  return { ordinal: 1, text: "2 cups flour", name: "flour", quantity: 2, unit: "cups", foodSlug: "flour", via: "exact", traits: null, ...overrides };
}

function fakeLabel(overrides: Partial<Label> = {}): Label {
  return {
    dimension: "allergen",
    slug: "gluten",
    verdict: "contains",
    confidence: 0.9,
    method: "llm:moonshot:kimi-k2-0905-preview@1",
    evidence: { rule: "llm", lines: [] },
    ...overrides,
  };
}

function fakeDisagreement(overrides: Partial<Disagreement> = {}): Disagreement {
  return { dimension: "allergen", slug: "fish", rulesVerdict: "contains", llmVerdict: "not_detected", llmConfidence: 0.4, ...overrides };
}

// --- buildDisagreementEvent / sendDisagreementEvent — unchanged behaviour ---

describe("buildDisagreementEvent — shape (plan §8, §5.4, §5.5)", () => {
  it("carries the recipe identity, the service distinct id, and the Disagreement fields verbatim", () => {
    const result = buildDisagreementEvent({ recipeId: "recipe-7", recipeOrigin: "sync", disagreement: fakeDisagreement() });
    expect(result.distinctId).toBe(PIPELINE_DISTINCT_ID);
    expect(result.event).toBe("llm_enrichment_disagreement");
    expect(result.event).toBe(DISAGREEMENT_EVENT);
    expect(result.properties).toEqual({
      recipe_id: "recipe-7",
      recipe_origin: "sync",
      dimension: "allergen",
      slug: "fish",
      rules_verdict: "contains",
      llm_verdict: "not_detected",
      llm_confidence: 0.4,
    });
  });

  it("carries rulesVerdict: null through as null when the rules had no row", () => {
    const result = buildDisagreementEvent({
      recipeId: "recipe-8",
      recipeOrigin: "local",
      disagreement: fakeDisagreement({ dimension: "diet", slug: "keto", rulesVerdict: null, llmVerdict: "likely", llmConfidence: 0.55 }),
    });
    expect(result.properties.rules_verdict).toBeNull();
    expect(result.properties.recipe_origin).toBe("local");
  });

  it("uses the service distinct id, never the recipe id, for both origins", () => {
    const sync = buildDisagreementEvent({ recipeId: "recipe-9", recipeOrigin: "sync", disagreement: fakeDisagreement() });
    const local = buildDisagreementEvent({ recipeId: "recipe-9", recipeOrigin: "local", disagreement: fakeDisagreement() });
    expect(sync.distinctId).toBe("recipe-enrichment-pipeline");
    expect(local.distinctId).toBe("recipe-enrichment-pipeline");
  });
});

describe("buildDisagreementEvent — no ingredient text can leak in", () => {
  it("emits exactly the seven known keys and nothing else, for every dimension", () => {
    const expectedKeys = ["recipe_id", "recipe_origin", "dimension", "slug", "rules_verdict", "llm_verdict", "llm_confidence"].sort();
    for (const dimension of ["allergen", "diet", "cuisine", "meal_type", "spice_level"] as const) {
      const { properties } = buildDisagreementEvent({ recipeId: "recipe-x", recipeOrigin: "sync", disagreement: fakeDisagreement({ dimension }) });
      expect(Object.keys(properties).sort()).toEqual(expectedKeys);
    }
  });

  it("has no field capable of carrying free text — every value is a recipe id, an enum-shaped string, a number, or null", () => {
    // `Disagreement` itself has no `evidence`/line-text field (types.ts) —
    // this test pins that the event-building step doesn't add one back in,
    // e.g. by accidentally spreading in a `note` or `evidence` from
    // somewhere else. Any long free-text value here would be a smell even
    // without knowing what the field is called.
    const { properties } = buildDisagreementEvent({
      recipeId: "recipe-y",
      recipeOrigin: "sync",
      disagreement: fakeDisagreement({ slug: "fish", rulesVerdict: "contains", llmVerdict: "not_detected" }),
    });
    for (const [key, value] of Object.entries(properties)) {
      if (typeof value === "string") {
        expect(value.length, `property ${key} looks too long to be an id/slug/verdict`).toBeLessThan(64);
      }
    }
    expect(properties).not.toHaveProperty("evidence");
    expect(properties).not.toHaveProperty("note");
    expect(properties).not.toHaveProperty("ingredients");
    expect(properties).not.toHaveProperty("lines");
  });
});

// --- buildEnrichmentCompletedEvent / captureEnrichmentCompleted -------------

function completedInput(overrides: Partial<EnrichmentCompletedInput> = {}): EnrichmentCompletedInput {
  return {
    traceId: "trace-abc-123",
    recipeId: "recipe-1",
    recipeOrigin: "sync",
    provider: fakeProvider(),
    prompt: fakePrompt(),
    lines: [fakeLine({ ordinal: 1, foodSlug: "flour" }), fakeLine({ ordinal: 2, foodSlug: "sugar" })],
    llmVersion: 1,
    writes: [fakeLabel()],
    disagreements: [],
    ...overrides,
  };
}

describe("buildEnrichmentCompletedEvent — shape and the join key", () => {
  it("carries the trace id, ai_feature, and the recipe/prompt/model identity", () => {
    const { distinctId, event, properties } = buildEnrichmentCompletedEvent(completedInput());
    expect(distinctId).toBe(PIPELINE_DISTINCT_ID);
    expect(event).toBe(ENRICHMENT_COMPLETED_EVENT);
    expect(event).toBe("llm_enrichment_completed");
    expect(properties).toMatchObject({
      // The join key back to the generation span this event describes.
      $ai_trace_id: "trace-abc-123",
      ai_feature: AI_FEATURE,
      recipe_id: "recipe-1",
      recipe_origin: "sync",
      prompt_name: "recipe-llm-enrichment",
      prompt_version: 3,
      llm_version: 1,
      model: "moonshot:kimi-k2-0905-preview",
    });
  });

  it("computes labels_written, disagreements, line_count and unresolved_line_count from writes/disagreements/lines, not passed through", () => {
    const { properties } = buildEnrichmentCompletedEvent(
      completedInput({
        writes: [fakeLabel({ slug: "gluten" }), fakeLabel({ slug: "dairy" }), fakeLabel({ slug: "soy" })],
        disagreements: [fakeDisagreement(), fakeDisagreement({ slug: "shellfish" })],
        lines: [
          fakeLine({ ordinal: 1, foodSlug: "flour" }),
          fakeLine({ ordinal: 2, foodSlug: null }),
          fakeLine({ ordinal: 3, foodSlug: null }),
          fakeLine({ ordinal: 4, foodSlug: "egg" }),
        ],
      }),
    );
    expect(properties.labels_written).toBe(3);
    expect(properties.disagreements).toBe(2);
    expect(properties.line_count).toBe(4);
    // Only the two lines with foodSlug: null are unresolved — computed by
    // filtering, not a count handed in verbatim.
    expect(properties.unresolved_line_count).toBe(2);
  });

  it("prompt_version: null rides through verbatim — the committed fallback prompt ran, and that is a real value, not an absent key", () => {
    const { properties } = buildEnrichmentCompletedEvent(completedInput({ prompt: fakePrompt({ version: null }) }));
    expect(properties).toHaveProperty("prompt_version", null);
  });

  it("recipe_origin passes through both origins, and line_count/unresolved_line_count are zero for an empty line set", () => {
    const local = buildEnrichmentCompletedEvent(completedInput({ recipeOrigin: "local", lines: [], writes: [], disagreements: [] }));
    expect(local.properties.recipe_origin).toBe("local");
    expect(local.properties.line_count).toBe(0);
    expect(local.properties.unresolved_line_count).toBe(0);
    expect(local.properties.labels_written).toBe(0);
    expect(local.properties.disagreements).toBe(0);
  });
});

describe("captureEnrichmentCompleted — emits one completion event plus one disagreement event per disagreement", () => {
  it("sends exactly 1 + N capture calls for N disagreements, completion first", () => {
    const { client, capture } = fakeClient();
    const log = fakeLog();
    const disagreements = [fakeDisagreement({ slug: "fish" }), fakeDisagreement({ slug: "shellfish" }), fakeDisagreement({ slug: "peanut" })];

    captureEnrichmentCompleted(client, log, completedInput({ disagreements }));

    expect(capture).toHaveBeenCalledTimes(4);
    const events = capture.mock.calls.map((call) => (call[0] as { event: string }).event);
    expect(events[0]).toBe(ENRICHMENT_COMPLETED_EVENT);
    expect(events.slice(1)).toEqual([DISAGREEMENT_EVENT, DISAGREEMENT_EVENT, DISAGREEMENT_EVENT]);
  });

  it("sends only the completion event when there are no disagreements", () => {
    const { client, capture } = fakeClient();
    captureEnrichmentCompleted(client, fakeLog(), completedInput({ disagreements: [] }));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(eventNameAt(capture, 0)).toBe(ENRICHMENT_COMPLETED_EVENT);
  });

  it("no-ops safely with a null client — never throws, and there is nothing to assert calls on", () => {
    expect(() => captureEnrichmentCompleted(null, fakeLog(), completedInput({ disagreements: [fakeDisagreement()] }))).not.toThrow();
  });
});

// --- buildEnrichmentFailedEvent / captureEnrichmentFailed -------------------

function failedInput(overrides: Partial<EnrichmentFailedInput> = {}): EnrichmentFailedInput {
  return {
    traceId: "trace-fail-1",
    recipeId: "recipe-2",
    recipeOrigin: "sync",
    provider: fakeProvider(),
    prompt: fakePrompt(),
    llmVersion: 1,
    message: "schema validation failed: unknown cuisine slug",
    rawText: undefined,
    ...overrides,
  };
}

describe("buildEnrichmentFailedEvent — shape and the schema-rejection split", () => {
  it("carries the trace id (join key), ai_feature, and the error message", () => {
    const { distinctId, event, properties } = buildEnrichmentFailedEvent(failedInput());
    expect(distinctId).toBe(PIPELINE_DISTINCT_ID);
    expect(event).toBe(ENRICHMENT_FAILED_EVENT);
    expect(event).toBe("llm_enrichment_failed");
    expect(properties).toMatchObject({
      $ai_trace_id: "trace-fail-1",
      ai_feature: AI_FEATURE,
      error: "schema validation failed: unknown cuisine slug",
    });
  });

  it("schema_rejection: true and a raw_output property when rawText is present — doGenerate succeeded, parsing failed", () => {
    const { properties } = buildEnrichmentFailedEvent(failedInput({ rawText: '{"cuisine": "not-a-real-slug"}' }));
    expect(properties.schema_rejection).toBe(true);
    expect(properties).toHaveProperty("raw_output", '{"cuisine": "not-a-real-slug"}');
  });

  it("schema_rejection: false and NO raw_output key when rawText is absent — the model never answered", () => {
    const { properties } = buildEnrichmentFailedEvent(failedInput({ rawText: undefined }));
    expect(properties.schema_rejection).toBe(false);
    // Not toBeUndefined() — a key can be present and set to undefined and
    // still pass that. This is the same "absent key, not a falsy value"
    // discipline the old redaction tests used for $ai_input/$ai_output_choices.
    expect(properties).not.toHaveProperty("raw_output");
  });
});

describe("captureEnrichmentFailed — sends exactly one event, no-ops safely with a null client", () => {
  it("sends the failed event once", () => {
    const { client, capture } = fakeClient();
    captureEnrichmentFailed(client, fakeLog(), failedInput());
    expect(capture).toHaveBeenCalledTimes(1);
    expect(eventNameAt(capture, 0)).toBe(ENRICHMENT_FAILED_EVENT);
  });

  it("never throws with a null client", () => {
    expect(() => captureEnrichmentFailed(null, fakeLog(), failedInput({ rawText: "raw model text" }))).not.toThrow();
  });
});
