import { describe, expect, it } from "vitest";
import { AI_FEATURE, AI_GENERATION_EVENT, buildDisagreementEvent, buildGenerationEvent, DISAGREEMENT_EVENT, PIPELINE_DISTINCT_ID } from "#/queues/recipe-enrichment/lib/capture.ts";
import type { GenerationEventInput } from "#/queues/recipe-enrichment/lib/capture.ts";
import type { Disagreement } from "#/queues/recipe-enrichment/types.ts";

/**
 * Pure suite over {@link buildGenerationEvent} and {@link buildDisagreementEvent}
 * — no PostHog client, no network, exactly what plan §12.1 asks for
 * (`llm/capture.test.ts`: "sync recipe carries `$ai_input`; local recipe
 * carries neither content field but keeps tokens/costs; error shape; custom
 * props"). The `send*` wrappers in `capture.ts` are one line of glue over
 * these and are not separately tested — there is nothing left in them to get
 * wrong once these are pinned, and exercising `process.env` plus a real
 * `posthog-node` client is exactly the live-call territory L11 rules out.
 */

function baseInput(overrides: Partial<GenerationEventInput> = {}): GenerationEventInput {
  return {
    traceId: "trace-abc-123",
    model: "kimi-k2-0905-preview",
    provider: "moonshot",
    baseUrl: "https://api.moonshot.ai/v1",
    latencyMs: 2500,
    usage: { inputTokens: 800, outputTokens: 150 },
    httpStatus: 200,
    recipeId: "recipe-1",
    recipeOrigin: "sync",
    promptName: "recipe-llm-enrichment",
    promptVersion: 3,
    llmVersion: 1,
    labelsWritten: 4,
    disagreements: 0,
    lineCount: 10,
    unresolvedLineCount: 1,
    messages: [{ role: "system", content: "you are a food classifier" }],
    outputChoices: [{ allergens: [] }],
    ...overrides,
  };
}

describe("buildGenerationEvent — distinct id and event name", () => {
  it("always uses the service identity, never a recipe or user id, for both origins", () => {
    const sync = buildGenerationEvent(baseInput({ recipeOrigin: "sync" }));
    const local = buildGenerationEvent(baseInput({ recipeOrigin: "local" }));
    expect(sync.distinctId).toBe(PIPELINE_DISTINCT_ID);
    expect(local.distinctId).toBe(PIPELINE_DISTINCT_ID);
    expect(sync.distinctId).toBe("recipe-enrichment-pipeline");
    // Never the recipe id itself, even though it's right there on the input.
    expect(sync.distinctId).not.toBe(sync.properties.recipe_id);
  });

  it("emits PostHog's own $ai_generation event name", () => {
    const { event } = buildGenerationEvent(baseInput());
    expect(event).toBe("$ai_generation");
    expect(event).toBe(AI_GENERATION_EVENT);
  });
});

describe("buildGenerationEvent — content redaction is origin-gated (L10)", () => {
  it("attaches $ai_input and $ai_output_choices for a sync recipe", () => {
    const { properties } = buildGenerationEvent(baseInput({ recipeOrigin: "sync" }));
    expect(properties).toHaveProperty("$ai_input");
    expect(properties).toHaveProperty("$ai_output_choices");
    expect(properties.$ai_input).toEqual([{ role: "system", content: "you are a food classifier" }]);
    expect(properties.$ai_output_choices).toEqual([{ allergens: [] }]);
  });

  it("omits $ai_input and $ai_output_choices ENTIRELY for a local recipe — absent keys, not empty/falsy values", () => {
    const { properties } = buildGenerationEvent(baseInput({ recipeOrigin: "local" }));
    // The load-bearing assertion: not toBeUndefined() (a key could be present
    // and set to undefined and still pass that), but not present as a key at
    // all, matching how a real PostHog capture call serializes the object.
    expect(properties).not.toHaveProperty("$ai_input");
    expect(properties).not.toHaveProperty("$ai_output_choices");
    expect(Object.keys(properties)).not.toContain("$ai_input");
    expect(Object.keys(properties)).not.toContain("$ai_output_choices");
  });

  it("keeps tokens, latency, model, provider and cost fields on a local recipe despite the content redaction", () => {
    const { properties } = buildGenerationEvent(
      baseInput({
        recipeOrigin: "local",
        usage: { inputTokens: 900, outputTokens: 200 },
        latencyMs: 3000,
        pricing: { inputTokenPriceUsd: 0.000002, outputTokenPriceUsd: 0.000006 },
      }),
    );
    expect(properties.$ai_input_tokens).toBe(900);
    expect(properties.$ai_output_tokens).toBe(200);
    expect(properties.$ai_latency).toBe(3);
    expect(properties.$ai_model).toBe("kimi-k2-0905-preview");
    expect(properties.$ai_provider).toBe("moonshot");
    expect(properties.$ai_input_token_price).toBe(0.000002);
    expect(properties.$ai_output_token_price).toBe(0.000006);
  });
});

describe("buildGenerationEvent — $ai_latency is seconds, input is milliseconds", () => {
  it.each([
    [1000, 1],
    [2500, 2.5],
    [60_000, 60],
    [0, 0],
  ])("converts %ims to %is", (latencyMs, expectedSeconds) => {
    const { properties } = buildGenerationEvent(baseInput({ latencyMs }));
    expect(properties.$ai_latency).toBe(expectedSeconds);
  });
});

describe("buildGenerationEvent — error shape", () => {
  it("sets $ai_is_error and $ai_error only when input.error is present", () => {
    const ok = buildGenerationEvent(baseInput());
    expect(ok.properties).not.toHaveProperty("$ai_is_error");
    expect(ok.properties).not.toHaveProperty("$ai_error");

    const failed = buildGenerationEvent(baseInput({ error: { message: "schema validation failed: unknown cuisine slug" }, httpStatus: 200 }));
    expect(failed.properties.$ai_is_error).toBe(true);
    expect(failed.properties.$ai_error).toBe("schema validation failed: unknown cuisine slug");
  });

  it("still carries http status, model and tokens alongside an error", () => {
    const { properties } = buildGenerationEvent(baseInput({ error: { message: "timeout" }, httpStatus: 0, usage: { inputTokens: 800, outputTokens: 0 } }));
    expect(properties.$ai_http_status).toBe(0);
    expect(properties.$ai_input_tokens).toBe(800);
    expect(properties.$ai_output_tokens).toBe(0);
  });

  it("redaction still applies on an error for a local recipe", () => {
    const { properties } = buildGenerationEvent(baseInput({ recipeOrigin: "local", error: { message: "timeout" } }));
    expect(properties.$ai_is_error).toBe(true);
    expect(properties).not.toHaveProperty("$ai_input");
    expect(properties).not.toHaveProperty("$ai_output_choices");
  });
});

describe("buildGenerationEvent — custom properties, exact spellings (plan §10)", () => {
  it("sends every contractual custom property with the exact name evals/dashboards filter on", () => {
    const { properties } = buildGenerationEvent(
      baseInput({
        recipeId: "recipe-42",
        promptVersion: 7,
        llmVersion: 1,
        labelsWritten: 5,
        disagreements: 2,
        lineCount: 12,
        unresolvedLineCount: 3,
      }),
    );
    expect(properties).toMatchObject({
      ai_feature: "recipe-llm-enrichment",
      recipe_id: "recipe-42",
      recipe_origin: "sync",
      prompt_name: "recipe-llm-enrichment",
      prompt_version: 7,
      // PostHog's own prompt-provenance convention, sent alongside the plain
      // names so Prompt Management can tie this generation to the version that
      // produced it (`@posthog/ai` documents this pairing with `Prompts.get`).
      $ai_prompt_name: "recipe-llm-enrichment",
      $ai_prompt_version: 7,
      llm_version: 1,
      labels_written: 5,
      disagreements: 2,
      line_count: 12,
      unresolved_line_count: 3,
    });
    expect(properties.ai_feature).toBe(AI_FEATURE);
  });

  it("sends prompt_version: null verbatim when the prompt fetch fell back — null is a real value, not an absent key", () => {
    const { properties } = buildGenerationEvent(baseInput({ promptVersion: null }));
    expect(properties).toHaveProperty("prompt_version");
    expect(properties.prompt_version).toBeNull();
    // Both spellings have to agree, or "which recipes ran on the fallback?"
    // gets two different answers depending on which one somebody filters on.
    expect(properties).toHaveProperty("$ai_prompt_version");
    expect(properties.$ai_prompt_version).toBeNull();
  });

  it("$ai_span_name is the fixed classify-recipe span, regardless of origin or error", () => {
    expect(buildGenerationEvent(baseInput({ recipeOrigin: "sync" })).properties.$ai_span_name).toBe("classify-recipe");
    expect(buildGenerationEvent(baseInput({ recipeOrigin: "local", error: { message: "x" } })).properties.$ai_span_name).toBe("classify-recipe");
  });
});

describe("buildGenerationEvent — pricing passthrough (plan §5.3)", () => {
  it("sends $ai_input_token_price and $ai_output_token_price when pricing is supplied", () => {
    const { properties } = buildGenerationEvent(baseInput({ pricing: { inputTokenPriceUsd: 0.0000005, outputTokenPriceUsd: 0.0000015 } }));
    expect(properties.$ai_input_token_price).toBe(0.0000005);
    expect(properties.$ai_output_token_price).toBe(0.0000015);
  });

  it("omits both pricing properties entirely when pricing is not supplied", () => {
    const { properties } = buildGenerationEvent(baseInput({ pricing: undefined }));
    expect(properties).not.toHaveProperty("$ai_input_token_price");
    expect(properties).not.toHaveProperty("$ai_output_token_price");
  });

  it("sends only the one price actually supplied when pricing is partial", () => {
    const inputOnly = buildGenerationEvent(baseInput({ pricing: { inputTokenPriceUsd: 0.000001 } }));
    expect(inputOnly.properties.$ai_input_token_price).toBe(0.000001);
    expect(inputOnly.properties).not.toHaveProperty("$ai_output_token_price");

    const outputOnly = buildGenerationEvent(baseInput({ pricing: { outputTokenPriceUsd: 0.000003 } }));
    expect(outputOnly.properties).not.toHaveProperty("$ai_input_token_price");
    expect(outputOnly.properties.$ai_output_token_price).toBe(0.000003);
  });

  it("treats an explicit zero price as a real value, not as absent", () => {
    const { properties } = buildGenerationEvent(baseInput({ pricing: { inputTokenPriceUsd: 0, outputTokenPriceUsd: 0 } }));
    expect(properties).toHaveProperty("$ai_input_token_price", 0);
    expect(properties).toHaveProperty("$ai_output_token_price", 0);
  });
});

describe("buildGenerationEvent — determinism", () => {
  it("returns the same event for the same input", () => {
    const input = baseInput();
    expect(buildGenerationEvent(input)).toEqual(buildGenerationEvent(input));
  });
});

// --- buildDisagreementEvent -------------------------------------------

function disagreement(overrides: Partial<Disagreement> = {}): Disagreement {
  return {
    dimension: "allergen",
    slug: "fish",
    rulesVerdict: "contains",
    llmVerdict: "not_detected",
    llmConfidence: 0.4,
    ...overrides,
  };
}

describe("buildDisagreementEvent — shape (plan §8, §5.4, §5.5)", () => {
  it("carries the recipe identity, the service distinct id, and the Disagreement fields verbatim", () => {
    const result = buildDisagreementEvent({ recipeId: "recipe-7", recipeOrigin: "sync", disagreement: disagreement() });
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
      disagreement: disagreement({ dimension: "diet", slug: "keto", rulesVerdict: null, llmVerdict: "likely", llmConfidence: 0.55 }),
    });
    expect(result.properties.rules_verdict).toBeNull();
    expect(result.properties.recipe_origin).toBe("local");
  });

  it("uses the service distinct id, never the recipe id, for both origins", () => {
    const sync = buildDisagreementEvent({ recipeId: "recipe-9", recipeOrigin: "sync", disagreement: disagreement() });
    const local = buildDisagreementEvent({ recipeId: "recipe-9", recipeOrigin: "local", disagreement: disagreement() });
    expect(sync.distinctId).toBe("recipe-enrichment-pipeline");
    expect(local.distinctId).toBe("recipe-enrichment-pipeline");
  });
});

describe("buildDisagreementEvent — no ingredient text can leak in", () => {
  it("emits exactly the seven known keys and nothing else, for every dimension", () => {
    const expectedKeys = ["recipe_id", "recipe_origin", "dimension", "slug", "rules_verdict", "llm_verdict", "llm_confidence"].sort();
    for (const dimension of ["allergen", "diet", "cuisine", "meal_type", "spice_level"] as const) {
      const { properties } = buildDisagreementEvent({ recipeId: "recipe-x", recipeOrigin: "sync", disagreement: disagreement({ dimension }) });
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
      disagreement: disagreement({ slug: "fish", rulesVerdict: "contains", llmVerdict: "not_detected" }),
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
