import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { generateText, Output } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { generationTelemetry } from "#/lib/ai/telemetry.ts";

/**
 * `generationTelemetry` against a REAL `generateText` call and a REAL
 * in-memory OTel exporter — not a mock of the AI SDK's telemetry plumbing.
 * The one claim this suite exists to make load-bearing is §4 of
 * `docs/plans/2026-08-28-posthog-native-ai-observability.md`: a `local`
 * recipe's prompt and the model's answer must appear in NO exported span,
 * anywhere, in any form. "The flag is set" is not that claim — a boolean
 * could be threaded through correctly and the SDK could still leak the text
 * through some other attribute, or a future SDK version could change what
 * `recordInputs: false` actually suppresses. Only grepping the fully
 * serialized spans for the forbidden text proves the negative.
 *
 * ── WHY `BasicTracerProvider`, NOT `NodeSDK` ────────────────────────────────
 *
 * Measured in this repo (see `plugins/telemetry.ts`'s doc comment):
 * `NodeSDK` constructed with `{ spanProcessors: [...] }` registers a
 * genuinely recording provider but does not wire the caller-supplied
 * processors on this dependency set, so spans record and export nowhere.
 * `BasicTracerProvider` + `trace.setGlobalTracerProvider` is the setup that
 * was verified to actually export. Do not "simplify" this back to `NodeSDK`.
 *
 * ── ONE GLOBAL PROVIDER FOR THE WHOLE FILE ──────────────────────────────────
 *
 * `trace.setGlobalTracerProvider` sets a module-level singleton in
 * `@opentelemetry/api` — the OTel API itself warns on a second call and
 * ignores it. So the provider is registered once in `beforeAll`, every case
 * gets a fresh `InMemorySpanExporter` reset in `afterEach`, and the provider
 * itself is only shut down once, in `afterAll`.
 */

const exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider;

beforeAll(() => {
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});

afterEach(() => {
  exporter.reset();
});

afterAll(async () => {
  await provider.shutdown();
});

/** Valid output for the schema every case below asks the model for — `MockLanguageModelV4` needs to return something `Output.object` can parse. */
const outputSchema = z.object({ a: z.string() });

/** `total` is the only field these tests care about; the rest of `LanguageModelV4Usage`'s token-breakdown fields are required by the type, so every case fills them in as `undefined`. */
const usage = {
  inputTokens: { total: 11, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 7, text: undefined, reasoning: undefined },
};

function mockModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: "text", text: JSON.stringify({ a: "y" }) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        response: { id: "resp_probe", modelId: "kimi-test" },
        warnings: [],
      }),
  });
}

/** Every span attribute value, from every exported span, flattened into one string — the corpus the redaction proof greps. */
function allAttributesText(): string {
  return JSON.stringify(exporter.getFinishedSpans().map((span) => span.attributes));
}

describe("generationTelemetry — content redaction (docs/plans/2026-08-28-posthog-native-ai-observability.md §4)", () => {
  it("recordContent: false — the sentinel prompt and the sentinel answer appear in NO exported span attribute", async () => {
    const sentinelInput = "SENTINEL-INPUT-do-not-leak-93f1";
    const sentinelOutput = "SENTINEL-OUTPUT-do-not-leak-93f1";

    const model = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve({
          content: [{ type: "text", text: JSON.stringify({ a: sentinelOutput }) }],
          finishReason: { unified: "stop", raw: "stop" },
          usage,
          response: { id: "resp_probe", modelId: "kimi-test" },
          warnings: [],
        }),
    });

    await generateText({
      model,
      output: Output.object({ schema: outputSchema }),
      messages: [{ role: "system", content: sentinelInput }],
      allowSystemInMessages: true,
      telemetry: generationTelemetry({
        enabled: true,
        traceId: "trace-redaction",
        distinctId: "recipe-enrichment-pipeline",
        functionId: "classify-recipe",
        recordContent: false,
        attributes: {},
      }),
    });

    const spans = exporter.getFinishedSpans();
    // Sanity: the three spans one `generateText` call is measured to emit
    // actually landed, or the assertions below would pass vacuously with no
    // spans at all.
    expect(spans.length).toBeGreaterThan(0);

    const corpus = allAttributesText();
    expect(corpus).not.toContain(sentinelInput);
    expect(corpus).not.toContain(sentinelOutput);

    for (const span of spans) {
      expect(span.attributes).not.toHaveProperty("gen_ai.input.messages");
      expect(span.attributes).not.toHaveProperty("gen_ai.output.messages");
    }
  });

  it("negative control — recordContent: true DOES carry the sentinel prompt, so the case above isn't passing by accident", async () => {
    const sentinelInput = "SENTINEL-INPUT-should-appear-2c7a";

    await generateText({
      model: mockModel(),
      output: Output.object({ schema: outputSchema }),
      messages: [{ role: "system", content: sentinelInput }],
      allowSystemInMessages: true,
      telemetry: generationTelemetry({
        enabled: true,
        traceId: "trace-control",
        distinctId: "recipe-enrichment-pipeline",
        functionId: "classify-recipe",
        recordContent: true,
        attributes: {},
      }),
    });

    const corpus = allAttributesText();
    expect(corpus).toContain(sentinelInput);

    const withInput = exporter.getFinishedSpans().filter((span) => "gen_ai.input.messages" in span.attributes);
    expect(withInput.length).toBeGreaterThan(0);
  });
});

describe("generationTelemetry — custom attributes land on every span", () => {
  it("carries the recipe/prompt identity, the trace and span names, and the distinct id", async () => {
    await generateText({
      model: mockModel(),
      output: Output.object({ schema: outputSchema }),
      messages: [{ role: "user", content: "classify this" }],
      allowSystemInMessages: true,
      telemetry: generationTelemetry({
        enabled: true,
        traceId: "trace-attrs-123",
        distinctId: "recipe-enrichment-pipeline",
        functionId: "classify-recipe",
        recordContent: true,
        attributes: {
          ai_feature: "recipe-llm-enrichment",
          recipe_id: "recipe-42",
          recipe_origin: "sync",
          prompt_name: "recipe-llm-enrichment",
          $ai_prompt_name: "recipe-llm-enrichment",
          llm_version: 1,
          line_count: 10,
        },
      }),
    });

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.attributes).toMatchObject({
        ai_feature: "recipe-llm-enrichment",
        recipe_id: "recipe-42",
        recipe_origin: "sync",
        prompt_name: "recipe-llm-enrichment",
        $ai_prompt_name: "recipe-llm-enrichment",
        llm_version: 1,
        line_count: 10,
        "posthog.distinct_id": "recipe-enrichment-pipeline",
        $ai_trace_id: "trace-attrs-123",
        $ai_span_name: "classify-recipe",
      });
    }
  });

  it('drops null-valued attributes instead of stringifying them — absent key, not the string "null"', async () => {
    await generateText({
      model: mockModel(),
      output: Output.object({ schema: outputSchema }),
      messages: [{ role: "user", content: "classify this" }],
      allowSystemInMessages: true,
      telemetry: generationTelemetry({
        enabled: true,
        traceId: "trace-null-attr",
        distinctId: "recipe-enrichment-pipeline",
        functionId: "classify-recipe",
        recordContent: true,
        attributes: {
          prompt_version: null,
          $ai_prompt_version: null,
        },
      }),
    });

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.attributes).not.toHaveProperty("prompt_version");
      expect(span.attributes).not.toHaveProperty("$ai_prompt_version");
      // Not present as ANY spelling of the string "null" either — belt and
      // braces against a future refactor that stringifies instead of dropping.
      expect(JSON.stringify(span.attributes)).not.toContain('"null"');
    }
  });
});

describe("generationTelemetry — enabled: false", () => {
  it("returns { isEnabled: false } and produces no spans at all", async () => {
    const options = generationTelemetry({
      enabled: false,
      traceId: "trace-disabled",
      distinctId: "recipe-enrichment-pipeline",
      functionId: "classify-recipe",
      recordContent: true,
      attributes: { ai_feature: "recipe-llm-enrichment" },
    });
    expect(options).toEqual({ isEnabled: false });

    await generateText({
      model: mockModel(),
      output: Output.object({ schema: outputSchema }),
      messages: [{ role: "user", content: "classify this" }],
      allowSystemInMessages: true,
      telemetry: options,
    });

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
