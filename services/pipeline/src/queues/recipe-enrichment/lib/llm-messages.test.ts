import { generateText, NoObjectGeneratedError, Output } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { buildMessages, buildRecipeJson, modelRawText, RECIPE_JSON_VARIABLE } from "#/queues/recipe-enrichment/lib/llm-messages.ts";
import { llmOutputSchema } from "@buttery/food/llm";
import type { LlmOutput } from "@buttery/food/llm";
import type { ClassifierLine, Label } from "#/queues/recipe-enrichment/types.ts";

/**
 * `lib/llm-messages.ts`'s suite: the AI SDK's mock language model stands in
 * for the real provider — no live call is possible or attempted anywhere in
 * this file. The `generateText`/`Output.object` calls below exercise exactly
 * the shape `index.ts`'s `llm-enrich` step makes, so a schema or SDK
 * behavior change shows up here without a database.
 *
 * The substitution rules themselves are NOT retested here. `compilePrompt`
 * and `buildRecipeJson` moved to `@buttery/food/llm` with the prompt and the
 * schema, and `packages/food/src/llm/messages.test.ts` owns their cases; what
 * is left below is the AI-SDK boundary — that a compiled prompt survives a
 * real `generateText` round trip, and that `modelRawText` recovers what the
 * model actually said when the schema refuses it.
 */

// --- a minimal, valid MockLanguageModelV4 doGenerate result -----------------

function generateResultFor(rawText: string) {
  return {
    content: [{ type: "text" as const, text: rawText }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: {
      inputTokens: { total: 120, noCache: 120, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 40, text: 40, reasoning: undefined },
    },
    response: { id: "resp_fixture_1", modelId: "kimi-test" },
    // The SDK unconditionally reads `result.warnings` — an empty array here is
    // what a well-behaved provider with nothing to warn about returns.
    warnings: [],
  };
}

// --- fixtures ---------------------------------------------------------------

const RECIPE_LINES: ClassifierLine[] = [
  { ordinal: 1, text: "1 lb rice noodles", name: "rice noodles", quantity: 1, unit: "lb", foodSlug: "en:rice-noodles", via: "exact", traits: null },
  { ordinal: 2, text: "2 tbsp fish sauce", name: "fish sauce", quantity: 2, unit: "tbsp", foodSlug: null, via: "miss", traits: null },
  { ordinal: 3, text: "1 lime, juiced", name: "lime", quantity: 1, unit: null, foodSlug: "en:lime", via: "exact", traits: null },
];

const RULES_LABELS: Label[] = [
  {
    dimension: "allergen",
    slug: "fish",
    verdict: "may_contain",
    confidence: 0.6,
    method: "rules@2",
    evidence: { rule: "text-pattern-unresolved-line", lines: [{ ordinal: 2, text: "2 tbsp fish sauce", foodSlug: null }] },
  },
  {
    dimension: "diet",
    slug: "vegetarian",
    verdict: "excluded",
    confidence: 0.85,
    method: "rules@2",
    evidence: { rule: "unresolved-animal-text-pattern", lines: [{ ordinal: 2, text: "2 tbsp fish sauce", foodSlug: null }] },
  },
];

/** A minimal system prompt carrying the one variable `buildMessages` compiles. */
const FIXTURE_PROMPT = `You are a food-classification assistant. Judge the recipe below and emit only JSON matching the schema.\n\n${RECIPE_JSON_VARIABLE}`;

/** A fully-populated, schema-valid model output — every optional field present so the happy-path test can assert an exact round trip. */
const HAPPY_OUTPUT: LlmOutput = {
  allergens: [{ slug: "fish", verdict: "may_contain", confidence: 0.7, ordinals: [2], note: "fish sauce, unresolved by the lexicon" }],
  diets: [{ slug: "vegetarian", verdict: "excluded", confidence: 0.9, ordinals: [2], note: "fish sauce is animal-derived" }],
  cuisine: [{ slug: "thai", confidence: 0.8 }],
  mealType: [{ slug: "dinner", confidence: 0.55 }],
  spiceLevel: { slug: "medium", confidence: 0.5 },
};

/** Exercises the same call shape `index.ts`'s `llm-enrich` step makes: build the messages, call `generateText` with the schema-constrained `Output`. */
function generate(model: MockLanguageModelV4, rulesLabels: Label[] = RULES_LABELS) {
  const recipeJson = buildRecipeJson({ recipeName: '"Vegetarian" pad thai', lines: RECIPE_LINES, rulesLabels });
  const messages = buildMessages({ promptText: FIXTURE_PROMPT, recipeJson });
  return generateText({
    model,
    output: Output.object({ schema: llmOutputSchema }),
    messages,
    allowSystemInMessages: true,
    maxOutputTokens: 4096,
    abortSignal: AbortSignal.timeout(10_000),
  });
}

// --- generateText + Output.object(llmOutputSchema): happy path -------------

describe("generateText + Output.object(llmOutputSchema) — happy path", () => {
  it("flows a valid fixture output end to end to a validated LlmOutput", async () => {
    const model = new MockLanguageModelV4({ doGenerate: generateResultFor(JSON.stringify(HAPPY_OUTPUT)) });
    const result = await generate(model);
    expect(result.output).toEqual(HAPPY_OUTPUT);
  });

  it("passes the sparse-on-the-wire fixture through unchanged — an LLM finding nothing for a dimension stays an empty array/null, not a default row", async () => {
    const sparse: LlmOutput = { allergens: [], diets: [], cuisine: [], mealType: [], spiceLevel: null };
    const model = new MockLanguageModelV4({ doGenerate: generateResultFor(JSON.stringify(sparse)) });
    const result = await generate(model);
    expect(result.output).toEqual(sparse);
  });
});

// --- generateText: schema-rejected output -----------------------------------

describe("generateText — schema-rejected output: modelRawText(err) recovers the raw text", () => {
  it("recovers the raw text when the model returns prose-wrapped, unparseable JSON", async () => {
    const rawText = "Sure! Here is the classification:\n```json\n{ this is not valid json";
    const model = new MockLanguageModelV4({ doGenerate: generateResultFor(rawText) });

    await expect(generate(model)).rejects.toSatisfy((err: unknown) => {
      expect(NoObjectGeneratedError.isInstance(err)).toBe(true);
      expect(modelRawText(err)).toBe(rawText);
      return true;
    });
  });

  it("recovers the raw text when the JSON is well-formed but violates the closed enums", async () => {
    // "cajun" is not one of CUISINE_SLUGS (the real slug is "cajun_creole") —
    // a model hallucinating a plausible-sounding but unlisted slug is exactly
    // what the closed enums exist to catch.
    const invalidEnumOutput = { allergens: [], diets: [], cuisine: [{ slug: "cajun", confidence: 0.5 }], mealType: [], spiceLevel: null };
    const rawText = JSON.stringify(invalidEnumOutput);
    const model = new MockLanguageModelV4({ doGenerate: generateResultFor(rawText) });

    await expect(generate(model)).rejects.toSatisfy((err: unknown) => {
      expect(modelRawText(err)).toBe(rawText);
      return true;
    });
  });

  it("recovers the raw text when confidence is out of range", async () => {
    const invalidConfidenceOutput = { allergens: [{ slug: "fish", verdict: "contains", confidence: 1.5, ordinals: [2] }], diets: [], cuisine: [], mealType: [], spiceLevel: null };
    const rawText = JSON.stringify(invalidConfidenceOutput);
    const model = new MockLanguageModelV4({ doGenerate: generateResultFor(rawText) });

    await expect(generate(model)).rejects.toSatisfy((err: unknown) => {
      expect(modelRawText(err)).toBe(rawText);
      return true;
    });
  });

  it("returns undefined from modelRawText for a non-schema failure (an abort)", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: (options) =>
        new Promise((_resolve, reject) => {
          const signal = options.abortSignal;
          if (!signal) throw new Error("test setup error: abortSignal was not forwarded to doGenerate");
          const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }),
    });

    await expect(
      generateText({
        model,
        output: Output.object({ schema: llmOutputSchema }),
        messages: buildMessages({ promptText: FIXTURE_PROMPT, recipeJson: buildRecipeJson({ recipeName: "x", lines: [], rulesLabels: [] }) }),
        allowSystemInMessages: true,
        maxOutputTokens: 4096,
        abortSignal: AbortSignal.timeout(10),
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(modelRawText(err)).toBeUndefined();
      return true;
    });
  });
});

// --- the AI-SDK shape buildMessages adds on top of compilePrompt --------------

describe("buildMessages — the two-message shape the SDK requires", () => {
  it("puts the compiled prompt in a system turn and appends the fixed, content-free user turn", () => {
    const recipeJson = JSON.stringify({ name: "Test" });
    const messages = buildMessages({ promptText: FIXTURE_PROMPT, recipeJson });

    expect(messages).toHaveLength(2);
    const system = messages[0];
    expect(system?.role).toBe("system");
    expect(system?.content).toContain(recipeJson);
    expect(system?.content).not.toContain(RECIPE_JSON_VARIABLE);

    // The trailing user turn is fixed and carries no recipe content.
    const user = messages[1];
    expect(user?.role).toBe("user");
    expect(user?.content).not.toContain(recipeJson);
  });

  it("propagates compilePrompt's refusal of a prompt with no {{recipe_json}}", () => {
    expect(() => buildMessages({ promptText: "a prompt that forgot its variable", recipeJson: "{}" })).toThrow(RECIPE_JSON_VARIABLE);
  });
});
