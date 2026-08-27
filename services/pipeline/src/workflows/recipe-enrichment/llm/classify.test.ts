import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { buildMessages, buildRecipeJson, classifyWithLlm, LlmClassifyError, RECIPE_JSON_VARIABLE } from "#/workflows/recipe-enrichment/llm/classify.ts";
import type { LlmOutput } from "#/workflows/recipe-enrichment/llm/schema.ts";
import type { ClassifierLine, Label } from "#/workflows/recipe-enrichment/types.ts";

/**
 * `classify.ts`'s suite (llm plan §12.1, L11): the AI SDK's mock language
 * model stands in for Kimi, exactly the way the rules `classify.test.ts`
 * needs no lexicon load — no live Moonshot call is possible or attempted
 * anywhere in this file (plan §12.2). Every fixture below is hand-built JSON,
 * not a captured real response, because there are no keys to capture one
 * with.
 *
 * `generateText` (ai@7.0.79) accepts `LanguageModelV4` directly — confirmed
 * against `node_modules/ai/dist/index.d.ts`'s `LanguageModel` union — so
 * {@link MockLanguageModelV4} (from `ai/test`) is the mock this suite uses;
 * `ai/test` also ships a V3 mock, but nothing in this workflow ever
 * constructs a V3 model (`provider.ts`'s `@ai-sdk/openai-compatible`
 * `chatModel()` returns `LanguageModelV4` — see that file), so pinning to V4
 * here is exercising the model shape this codebase actually produces, not
 * merely one this codebase could accept.
 *
 * The suite reads the same after the `generateObject` → `generateText` +
 * `Output.object` migration because it was written against `classifyWithLlm`'s
 * own contract rather than against the SDK's — the mock returns raw text and
 * these tests assert on the validated output and the thrown error, both of
 * which the migration left alone (see `classify.ts`'s doc for what was
 * measured to establish that).
 */

// --- a minimal, valid MockLanguageModelV4 doGenerate result -----------------

/**
 * `MockLanguageModelV4.doGenerate`'s return shape
 * (`@ai-sdk/provider`'s `LanguageModelV4GenerateResult`) is considerably more
 * detailed than anything this file's assertions read — this builds exactly
 * enough of it (a single text content part carrying the raw JSON the schema-constrained
 * `Output` will try to validate, a finish reason, and a token count) to drive
 * `classifyWithLlm` end to end without hand-rolling the full shape at every
 * call site below.
 */
function generateResultFor(rawText: string) {
  return {
    content: [{ type: "text" as const, text: rawText }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: {
      inputTokens: { total: 120, noCache: 120, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 40, text: 40, reasoning: undefined },
    },
    response: { id: "resp_fixture_1", modelId: "kimi-test" },
    // The SDK unconditionally reads `result.warnings` — an empty
    // array here is what a well-behaved provider with nothing to warn about
    // returns; MockLanguageModelV4 does not default this field itself.
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

/**
 * A minimal system prompt carrying the one variable `buildMessages`
 * compiles — stands in for `prompt.ts`'s fallback / `prompt-fetch.ts`'s
 * `{text}` without depending on either (neither is this slice's file).
 */
const FIXTURE_PROMPT = `You are a food-classification assistant. Judge the recipe below and emit only JSON matching the schema.\n\n${RECIPE_JSON_VARIABLE}`;

/** A fully-populated, schema-valid model output — every optional field present so the happy-path test can assert an exact round trip. */
const HAPPY_OUTPUT: LlmOutput = {
  allergens: [{ slug: "fish", verdict: "may_contain", confidence: 0.7, ordinals: [2], note: "fish sauce, unresolved by the lexicon" }],
  diets: [{ slug: "vegetarian", verdict: "excluded", confidence: 0.9, ordinals: [2], note: "fish sauce is animal-derived" }],
  cuisine: [{ slug: "thai", confidence: 0.8 }],
  mealType: [{ slug: "dinner", confidence: 0.55 }],
  spiceLevel: { slug: "medium", confidence: 0.5 },
};

function callArgs(model: MockLanguageModelV4, overrides: Partial<Parameters<typeof classifyWithLlm>[0]> = {}) {
  return {
    model,
    promptText: FIXTURE_PROMPT,
    recipeName: '"Vegetarian" pad thai',
    lines: RECIPE_LINES,
    rulesLabels: RULES_LABELS,
    ...overrides,
  };
}

// --- classifyWithLlm: happy path --------------------------------------------

/**
 * The reason a mock model rejects with when the caller's signal aborts.
 *
 * `signal.reason` is typed `any` and is only *conventionally* an Error — the
 * real one from `AbortSignal.timeout` is a `TimeoutError` DOMException, which
 * is. Narrowing it here rather than passing it straight to `reject` keeps the
 * rejection typed (oxlint's `prefer-promise-reject-errors`) while still
 * preserving the genuine abort reason whenever there is one, which is what
 * `classifyWithLlm` re-throws unwrapped.
 */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

describe("classifyWithLlm — happy path (plan §7.1, §12.1)", () => {
  it("flows a valid fixture output end to end to a validated LlmOutput", async () => {
    const model = new MockLanguageModelV4({ doGenerate: generateResultFor(JSON.stringify(HAPPY_OUTPUT)) });

    const result = await classifyWithLlm(callArgs(model));

    // The validated object round-trips exactly — llmOutputSchema.parse applies
    // no transformation to an already-fully-populated fixture.
    expect(result.output).toEqual(HAPPY_OUTPUT);
  });

  it("carries usage, latency, the exact messages sent, and output choices for capture.ts", async () => {
    const model = new MockLanguageModelV4({ doGenerate: generateResultFor(JSON.stringify(HAPPY_OUTPUT)) });

    const result = await classifyWithLlm(callArgs(model));

    expect(result.usage.inputTokens).toBe(120);
    expect(result.usage.outputTokens).toBe(40);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.finishReason).toBe("stop");
    expect(result.responseId).toBe("resp_fixture_1");
    // ai@7's GenerateObjectResult never surfaces a numeric HTTP status on
    // success (see classify.ts's LlmClassifyResult.httpStatus doc) — pinned
    // here so a future SDK bump that starts supplying one is a visible
    // failure, not a silent behavior change nobody notices.
    expect(result.httpStatus).toBeUndefined();

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({ role: "system" });
    expect(result.messages[1]).toMatchObject({ role: "user" });

    expect(result.outputChoices).toEqual([{ role: "assistant", content: JSON.stringify(HAPPY_OUTPUT) }]);
  });

  it("passes the sparse-on-the-wire fixture through unchanged — an LLM finding nothing for a dimension stays an empty array/null, not a default row", async () => {
    const sparse: LlmOutput = { allergens: [], diets: [], cuisine: [], mealType: [], spiceLevel: null };
    const model = new MockLanguageModelV4({ doGenerate: generateResultFor(JSON.stringify(sparse)) });

    const result = await classifyWithLlm(callArgs(model));

    expect(result.output).toEqual(sparse);
  });
});

// --- classifyWithLlm: invalid / unparseable output --------------------------

describe("classifyWithLlm — schema-rejected output throws with the raw text attached (plan §7.1)", () => {
  it("throws LlmClassifyError with the raw text reachable when the model returns prose-wrapped, unparseable JSON", async () => {
    const rawText = "Sure! Here is the classification:\n```json\n{ this is not valid json";
    const model = new MockLanguageModelV4({ doGenerate: generateResultFor(rawText) });

    await expect(classifyWithLlm(callArgs(model))).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(LlmClassifyError);
      const llmErr = err as LlmClassifyError;
      expect(llmErr.rawText).toBe(rawText);
      return true;
    });
  });

  it("throws LlmClassifyError with the raw text reachable when the JSON is well-formed but violates the closed enums (plan L12)", async () => {
    // "cajun" is not one of CUISINE_SLUGS (the real slug is "cajun_creole") —
    // a model hallucinating a plausible-sounding but unlisted slug is exactly
    // what L12's closed enums exist to catch.
    const invalidEnumOutput = { allergens: [], diets: [], cuisine: [{ slug: "cajun", confidence: 0.5 }], mealType: [], spiceLevel: null };
    const rawText = JSON.stringify(invalidEnumOutput);
    const model = new MockLanguageModelV4({ doGenerate: generateResultFor(rawText) });

    await expect(classifyWithLlm(callArgs(model))).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(LlmClassifyError);
      expect((err as LlmClassifyError).rawText).toBe(rawText);
      return true;
    });
  });

  it("throws LlmClassifyError with the raw text reachable when confidence is out of range", async () => {
    const invalidConfidenceOutput = { allergens: [{ slug: "fish", verdict: "contains", confidence: 1.5, ordinals: [2] }], diets: [], cuisine: [], mealType: [], spiceLevel: null };
    const rawText = JSON.stringify(invalidConfidenceOutput);
    const model = new MockLanguageModelV4({ doGenerate: generateResultFor(rawText) });

    await expect(classifyWithLlm(callArgs(model))).rejects.toBeInstanceOf(LlmClassifyError);
  });
});

// --- classifyWithLlm: timeout / abort ---------------------------------------

describe("classifyWithLlm — an aborted/timed-out call throws (plan §9.2 step 5)", () => {
  it("rejects when the abort signal fires before the model ever responds", async () => {
    // A `doGenerate` that never resolves on its own — the only way this test
    // settles is the abort signal firing and the pending call rejecting, the
    // same shape a real 60s network hang would take (plan §9.2 step 5's
    // `AbortSignal.timeout(60_000)`, shortened here so the suite stays fast).
    const model = new MockLanguageModelV4({
      doGenerate: (options) =>
        new Promise((_resolve, reject) => {
          const signal = options.abortSignal;
          if (!signal) throw new Error("test setup error: abortSignal was not forwarded to doGenerate");
          const onAbort = () => reject(abortReason(signal));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }),
    });

    await expect(classifyWithLlm(callArgs(model, { abortSignal: AbortSignal.timeout(10) }))).rejects.toThrow();
  });

  it("rejects immediately for a signal that is already aborted", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: (options) =>
        new Promise((_resolve, reject) => {
          const signal = options.abortSignal;
          if (signal?.aborted) reject(abortReason(signal));
        }),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(classifyWithLlm(callArgs(model, { abortSignal: controller.signal }))).rejects.toThrow();
  });
});

// --- the pure builders --------------------------------------------------------

describe("buildRecipeJson — the {{recipe_json}} payload (plan §6.3)", () => {
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

describe("buildMessages — {{recipe_json}} substitution (plan §6.2, §6.3)", () => {
  it("substitutes the variable into the system message and leaves no unsubstituted variable behind", () => {
    const recipeJson = JSON.stringify({ name: "Test" });
    const messages = buildMessages({ promptText: FIXTURE_PROMPT, recipeJson });

    expect(messages).toHaveLength(2);
    const system = messages[0];
    expect(system?.role).toBe("system");
    expect(system?.content).toContain(recipeJson);
    expect(system?.content).not.toContain(RECIPE_JSON_VARIABLE);

    // The trailing user turn is fixed and carries no recipe content — see
    // classify.ts's doc comment on why it exists at all.
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
