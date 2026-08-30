import { describe, expect, it } from "vitest";
import { buildRecipeJson, compilePrompt, RECIPE_JSON_VARIABLE } from "./messages.ts";
import type { ClassifierLine, Label } from "../classifiers/types.ts";

/**
 * The pure builders' suite — `buildRecipeJson` and `compilePrompt`, with no
 * model anywhere near it. The AI-SDK half of what used to be one file
 * (`generateText` against a `MockLanguageModelV4`, and `modelRawText`) stayed
 * in `services/pipeline/src/queues/recipe-enrichment/lib/llm-messages.test.ts`,
 * because `buildMessages` and the `ai` package it wraps stayed there too.
 */

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

describe("compilePrompt — {{recipe_json}} substitution", () => {
  const FIXTURE_PROMPT = `You are a food-classification assistant. Judge the recipe below and emit only JSON matching the schema.\n\n${RECIPE_JSON_VARIABLE}`;

  it("substitutes the variable and leaves no unsubstituted variable behind", () => {
    const recipeJson = JSON.stringify({ name: "Test" });
    const compiled = compilePrompt({ promptText: FIXTURE_PROMPT, recipeJson });

    expect(compiled).toContain(recipeJson);
    expect(compiled).not.toContain(RECIPE_JSON_VARIABLE);
  });

  it("throws when the prompt text has no {{recipe_json}} occurrence at all", () => {
    expect(() => compilePrompt({ promptText: "a prompt that forgot its variable", recipeJson: "{}" })).toThrow(RECIPE_JSON_VARIABLE);
  });

  it("substitutes every occurrence, not just the first, if a prompt template repeats the variable", () => {
    const promptText = `${RECIPE_JSON_VARIABLE} ... reminder: ${RECIPE_JSON_VARIABLE}`;
    expect(compilePrompt({ promptText, recipeJson: "{}" })).not.toContain(RECIPE_JSON_VARIABLE);
  });
});

describe("compilePrompt — the other prompt variables", () => {
  it("substitutes every supplied variable, each occurrence", () => {
    const promptText = `allergens: {{allergen_slugs}}\ndiets: {{diet_slugs}}\nreminder, allergens again: {{allergen_slugs}}\n${RECIPE_JSON_VARIABLE}`;
    const compiled = compilePrompt({
      promptText,
      recipeJson: "{}",
      variables: { allergen_slugs: "milk, egg", diet_slugs: "vegan, keto" },
    });

    expect(compiled).toContain("allergens: milk, egg");
    expect(compiled).toContain("diets: vegan, keto");
    expect(compiled).toContain("reminder, allergens again: milk, egg");
    expect(compiled).not.toContain("{{allergen_slugs}}");
  });

  it("leaves an unknown variable untouched rather than throwing — a PostHog version may predate one we send", () => {
    const promptText = `lists: {{allergen_slugs}} and {{invented_later}}\n${RECIPE_JSON_VARIABLE}`;
    const compiled = compilePrompt({ promptText, recipeJson: "{}", variables: { allergen_slugs: "milk" } });
    expect(compiled).toContain("lists: milk and {{invented_later}}");
  });

  it("still compiles a prompt that carries its slug lists inline and takes no variables", () => {
    const promptText = `allergens: milk, egg\n${RECIPE_JSON_VARIABLE}`;
    const compiled = compilePrompt({ promptText, recipeJson: "{}", variables: { allergen_slugs: "milk, egg" } });
    expect(compiled).toBe("allergens: milk, egg\n{}");
  });

  it("does not re-substitute variable tokens that came in with the recipe JSON", () => {
    // A recipe named `{{diet_slugs}}` must reach the model as those literal
    // characters — the recipe payload is substituted last, precisely so a
    // user-supplied name cannot expand into one of our lists.
    const recipeJson = buildRecipeJson({ recipeName: "{{diet_slugs}}", lines: [], rulesLabels: [] });
    const promptText = `diets: {{diet_slugs}}\n${RECIPE_JSON_VARIABLE}`;
    const compiled = compilePrompt({ promptText, recipeJson, variables: { diet_slugs: "vegan, keto" } });

    expect(compiled).toContain("diets: vegan, keto");
    expect(compiled).toContain('"name":"{{diet_slugs}}"');
  });
});
