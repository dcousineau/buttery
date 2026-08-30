import { generateText, NoObjectGeneratedError, Output } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { buildMessages, buildRecipeJson, modelRawText, RECIPE_JSON_VARIABLE } from "#/queues/recipe-enrichment/lib/llm-messages.ts";
import { llmOutputSchema } from "#/queues/recipe-enrichment/lib/schema.ts";
import type { LlmOutput } from "#/queues/recipe-enrichment/lib/schema.ts";
import type { ClassifierLine, Label } from "#/queues/recipe-enrichment/types.ts";

/**
 * `lib/llm-messages.ts`'s suite: the AI SDK's mock language model stands in
 * for the real provider — no live call is possible or attempted anywhere in
 * this file. The `generateText`/`Output.object` calls below exercise exactly
 * the shape `index.ts`'s `llm-enrich` step makes, so a schema or SDK
 * behavior change shows up here without a database.
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

// --- the pure builders --------------------------------------------------------

describe("buildRecipeJson — the {{recipe_json}} payload", () => {
  it("includes every line's ordinal and text, and the rules labels as context", () => {
    const json = buildRecipeJson({ recipeName: '"Vegetarian" pad thai', lines: RECIPE_LINES, rulesLabels: RULES_LABELS });
    const parsed = JSON.parse(json) as { name: string; ingredients: Array<{ ordinal: number; text: string }>; rulesLabels: unknown[] };

    expect(parsed.name).toBe('"Vegetarian" pad thai');
    expect(parsed.ingredients).toEqual([
      { ordinal: 1, text: "1 lb rice noodles" },
      { ordinal: 2, text: "2 tbsp fish sauce" },
      { ordinal: 3, text: "1 lime, juiced" },
    ]);
    expect(parsed.rulesLabels).toEqual([
      { dimension: "allergen", slug: "fish", verdict: "may_contain", confidence: 0.6 },
      { dimension: "diet", slug: "vegetarian", verdict: "excluded", confidence: 0.85 },
    ]);
  });

  it("produces an empty ingredients/rulesLabels array for a recipe with neither, not an omitted field", () => {
    const json = buildRecipeJson({ recipeName: "Plain water", lines: [], rulesLabels: [] });
    const parsed = JSON.parse(json) as { ingredients: unknown[]; rulesLabels: unknown[] };
    expect(parsed.ingredients).toEqual([]);
    expect(parsed.rulesLabels).toEqual([]);
  });
});

describe("buildMessages — {{recipe_json}} substitution", () => {
  it("substitutes the variable into the system message and leaves no unsubstituted variable behind", () => {
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

  it("throws when the prompt text has no {{recipe_json}} occurrence at all", () => {
    expect(() => buildMessages({ promptText: "a prompt that forgot its variable", recipeJson: "{}" })).toThrow(RECIPE_JSON_VARIABLE);
  });

  it("substitutes every occurrence, not just the first, if a prompt template repeats the variable", () => {
    const promptText = `${RECIPE_JSON_VARIABLE} ... reminder: ${RECIPE_JSON_VARIABLE}`;
    const messages = buildMessages({ promptText, recipeJson: "{}" });
    expect(messages[0]?.content).not.toContain(RECIPE_JSON_VARIABLE);
  });
});

/** The system turn's text. `ModelMessage["content"]` is a union; `buildMessages` always puts a plain string in this one. */
function systemText(messages: ReturnType<typeof buildMessages>): string {
  const content = messages[0]?.content;
  if (typeof content !== "string") throw new Error(`expected a string system message, got ${typeof content}`);
  return content;
}

describe("buildMessages — the other prompt variables", () => {
  it("substitutes every supplied variable, each occurrence", () => {
    const promptText = `allergens: {{allergen_slugs}}\ndiets: {{diet_slugs}}\nreminder, allergens again: {{allergen_slugs}}\n${RECIPE_JSON_VARIABLE}`;
    const messages = buildMessages({
      promptText,
      recipeJson: "{}",
      variables: { allergen_slugs: "milk, egg", diet_slugs: "vegan, keto" },
    });

    const system = systemText(messages);
    expect(system).toContain("allergens: milk, egg");
    expect(system).toContain("diets: vegan, keto");
    expect(system).toContain("reminder, allergens again: milk, egg");
    expect(system).not.toContain("{{allergen_slugs}}");
  });

  it("leaves an unknown variable untouched rather than throwing — a PostHog version may predate one we send", () => {
    const promptText = `lists: {{allergen_slugs}} and {{invented_later}}\n${RECIPE_JSON_VARIABLE}`;
    const messages = buildMessages({ promptText, recipeJson: "{}", variables: { allergen_slugs: "milk" } });
    expect(systemText(messages)).toContain("lists: milk and {{invented_later}}");
  });

  it("still compiles a prompt that carries its slug lists inline and takes no variables", () => {
    const promptText = `allergens: milk, egg\n${RECIPE_JSON_VARIABLE}`;
    const messages = buildMessages({ promptText, recipeJson: "{}", variables: { allergen_slugs: "milk, egg" } });
    expect(systemText(messages)).toBe("allergens: milk, egg\n{}");
  });

  it("does not re-substitute variable tokens that came in with the recipe JSON", () => {
    // A recipe named `{{diet_slugs}}` must reach the model as those literal
    // characters — the recipe payload is substituted last, precisely so a
    // user-supplied name cannot expand into one of our lists.
    const recipeJson = buildRecipeJson({ recipeName: "{{diet_slugs}}", lines: [], rulesLabels: [] });
    const promptText = `diets: {{diet_slugs}}\n${RECIPE_JSON_VARIABLE}`;
    const messages = buildMessages({ promptText, recipeJson, variables: { diet_slugs: "vegan, keto" } });

    const system = systemText(messages);
    expect(system).toContain("diets: vegan, keto");
    expect(system).toContain('"name":"{{diet_slugs}}"');
  });
});
