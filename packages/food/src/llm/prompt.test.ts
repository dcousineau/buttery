import { describe, expect, it } from "vitest";
import { FALLBACK_PROMPT, PROMPT_SLUG_LISTS, PROMPT_VARIABLES } from "./prompt.ts";
import { buildRecipeJson, compilePrompt } from "./messages.ts";
import { CUISINE_SLUGS, LLM_ALLERGEN_SLUGS, LLM_DIET_SLUGS, MEAL_TYPE_SLUGS, SPICE_LEVEL_SLUGS } from "./schema.ts";

/**
 * The prompt's half of the schema contract. `schema.test.ts` pins the slug
 * sets to `LLM_ENRICHMENT_VERSION`; this file pins the prompt to those same
 * sets — that a slug added in `schema.ts` is a slug the model is actually
 * asked about, without anybody retyping a list.
 */

const EMPTY_RECIPE_JSON = buildRecipeJson({ recipeName: "Plain water", lines: [], rulesLabels: [] });

/** What the model really receives: the fallback text with every variable filled. */
function compiledFallback(): string {
  return compilePrompt({ promptText: FALLBACK_PROMPT, recipeJson: EMPTY_RECIPE_JSON, variables: PROMPT_SLUG_LISTS });
}

describe("PROMPT_SLUG_LISTS", () => {
  it("renders each closed set from schema.ts, in source order", () => {
    expect(PROMPT_SLUG_LISTS).toEqual({
      allergen_slugs: LLM_ALLERGEN_SLUGS.join(", "),
      diet_slugs: LLM_DIET_SLUGS.join(", "),
      cuisine_slugs: CUISINE_SLUGS.join(", "),
      meal_type_slugs: MEAL_TYPE_SLUGS.join(", "),
      spice_level_slugs: SPICE_LEVEL_SLUGS.join(", "),
    });
  });

  it("covers every declared variable except the recipe payload", () => {
    expect(Object.keys(PROMPT_SLUG_LISTS).sort()).toEqual([...PROMPT_VARIABLES].filter((name) => name !== "recipe_json").sort());
  });
});

describe("FALLBACK_PROMPT", () => {
  it("carries every declared variable", () => {
    for (const name of PROMPT_VARIABLES) {
      expect(FALLBACK_PROMPT).toContain(`{{${name}}}`);
    }
  });

  it("does not restate the cuisine list inline — that list arrives as a variable, so drift is not constructible", () => {
    // Cuisines only: the prose deliberately names some allergens and diets by
    // hand (the butter/milk example, the six shape-guess diets), so a blanket
    // "no slug appears in the text" assertion would be asserting the wrong
    // thing. Cuisine slugs appear nowhere but their list, which makes them the
    // honest canary for someone pasting a rendered list back into the text.
    const withoutList = FALLBACK_PROMPT.replaceAll("{{cuisine_slugs}}", "");
    for (const slug of CUISINE_SLUGS) {
      expect(withoutList).not.toContain(slug);
    }
  });

  it("compiles with no unsubstituted variable left behind", () => {
    expect(compiledFallback()).not.toMatch(/\{\{[a-z_]+\}\}/);
  });

  it("asks the model about every slug the schema will accept", () => {
    const compiled = compiledFallback();
    for (const slug of [...LLM_ALLERGEN_SLUGS, ...LLM_DIET_SLUGS, ...CUISINE_SLUGS, ...MEAL_TYPE_SLUGS, ...SPICE_LEVEL_SLUGS]) {
      expect(compiled).toContain(slug);
    }
  });
});
