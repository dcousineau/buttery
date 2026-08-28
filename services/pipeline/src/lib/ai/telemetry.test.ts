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
 * The claim this suite makes load-bearing is the one the module doc comment
 * argues for: every generation carries its prompt and the model's answer, for
 * every recipe, with no origin-dependent redaction anywhere in the path.
 * `recordInputs: true` being passed is not that claim — the SDK's defaults
 * could change, or an integration could strip the messages back off — so the
 * assertions grep the fully serialized spans for the sentinel text instead of
 * asserting the flag.
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

/** Every span attribute value, from every exported span, flattened into one string — the corpus the sentinel assertions grep. */
function allAttributesText(): string {
  return JSON.stringify(exporter.getFinishedSpans().map((span) => span.attributes));
}

describe("generationTelemetry — prompt and output text are always recorded", () => {
  it("carries the sentinel prompt AND the sentinel answer into the exported span attributes", async () => {
    const sentinelInput = "SENTINEL-INPUT-93f1";
    const sentinelOutput = "SENTINEL-OUTPUT-93f1";

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
        traceId: "trace-content",
        distinctId: "recipe-enrichment-pipeline",
        functionId: "classify-recipe",
        attributes: {},
      }),
    });

    const spans = exporter.getFinishedSpans();
    // Sanity: the three spans one `generateText` call is measured to emit
    // actually landed, or the assertions below would pass vacuously.
    expect(spans.length).toBeGreaterThan(0);

    const corpus = allAttributesText();
    expect(corpus).toContain(sentinelInput);
    expect(corpus).toContain(sentinelOutput);

    expect(spans.filter((span) => "gen_ai.input.messages" in span.attributes).length).toBeGreaterThan(0);
    expect(spans.filter((span) => "gen_ai.output.messages" in span.attributes).length).toBeGreaterThan(0);
  });

  it("records a `local`-origin generation exactly like a `sync` one — origin is a span attribute, not a gate", async () => {
    const sentinelInput = "SENTINEL-LOCAL-2c7a";

    await generateText({
      model: mockModel(),
      output: Output.object({ schema: outputSchema }),
      messages: [{ role: "system", content: sentinelInput }],
      allowSystemInMessages: true,
      telemetry: generationTelemetry({
        enabled: true,
        traceId: "trace-local",
        distinctId: "recipe-enrichment-pipeline",
        functionId: "classify-recipe",
        attributes: { recipe_origin: "local" },
      }),
    });

    const corpus = allAttributesText();
    expect(corpus).toContain(sentinelInput);
    for (const span of exporter.getFinishedSpans()) {
      expect(span.attributes).toMatchObject({ recipe_origin: "local" });
    }
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
