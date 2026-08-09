import { describe, expect, it } from "vitest";
import { coerceDiets, coerceImages, coerceInstructions, coerceKeywords, coerceNutrition, coerceRecipe, coerceYield, isRecipeNode } from "./coerce.ts";

const BASE = "https://example.com/recipes/cookies";

describe("isRecipeNode", () => {
  it("accepts the @type forms sites emit", () => {
    expect(isRecipeNode({ "@type": "Recipe" })).toBe(true);
    expect(isRecipeNode({ "@type": ["Article", "Recipe"] })).toBe(true);
    expect(isRecipeNode({ "@type": "http://schema.org/Recipe" })).toBe(true);
    expect(isRecipeNode({ "@type": "WebSite" })).toBe(false);
    expect(isRecipeNode("Recipe")).toBe(false);
  });
});

describe("coerceInstructions", () => {
  it("flattens HowToStep, HowToSection, and bare strings alike", () => {
    expect(coerceInstructions([{ "@type": "HowToStep", text: "One." }, "Two."])).toEqual(["One.", "Two."]);
    expect(coerceInstructions([{ "@type": "HowToSection", itemListElement: [{ "@type": "HowToStep", text: "A." }, { text: "B." }] }])).toEqual(["A.", "B."]);
  });

  it("splits a single newline-joined blob", () => {
    expect(coerceInstructions("One.\n\nTwo.\r\nThree.")).toEqual(["One.", "Two.", "Three."]);
  });
});

describe("coerceImages", () => {
  it("takes URLs from strings, ImageObjects, and arrays, absolutized", () => {
    expect(coerceImages("/hero.jpg", BASE)).toEqual(["https://example.com/hero.jpg"]);
    expect(coerceImages({ "@type": "ImageObject", contentUrl: "/b.jpg" }, BASE)).toEqual(["https://example.com/b.jpg"]);
    expect(coerceImages(["/a.jpg", { url: "/b.jpg" }], BASE)).toEqual(["https://example.com/a.jpg", "https://example.com/b.jpg"]);
    expect(coerceImages("javascript:alert(1)", BASE)).toEqual([]); // non-http dropped
  });
});

describe("coerceKeywords / coerceYield / coerceDiets", () => {
  it("splits a comma string but passes an array through", () => {
    expect(coerceKeywords("cookies, dessert ,  brown butter")).toEqual(["cookies", "dessert", "brown butter"]);
    expect(coerceKeywords(["cookies", "  "])).toEqual(["cookies"]);
  });

  it("accepts a bare numeric yield", () => {
    expect(coerceYield(4)).toBe("4");
    expect(coerceYield("24 cookies")).toBe("24 cookies");
  });

  it("canonicalizes diets and drops non-members", () => {
    expect(coerceDiets(["VeganDiet", "https://schema.org/NotADiet"])).toEqual(["https://schema.org/VeganDiet"]);
  });
});

describe("coerceNutrition", () => {
  it("strips schema.org's baked-in units", () => {
    expect(coerceNutrition({ calories: "210 calories", fatContent: "11 g", proteinContent: 4 })).toEqual({ calories: 210, fatContent: 11, proteinContent: 4 });
  });

  it("is undefined when nothing parses", () => {
    expect(coerceNutrition({ calories: "unknown" })).toBeUndefined();
    expect(coerceNutrition(null)).toBeUndefined();
  });
});

describe("coerceRecipe", () => {
  it("reads the legacy `ingredients` spelling when `recipeIngredient` is absent", () => {
    expect(coerceRecipe({ ingredients: ["salt"] }, BASE).ingredients).toEqual(["salt"]);
    // The correct property wins when a page emits both.
    expect(coerceRecipe({ recipeIngredient: ["sugar"], ingredients: ["salt"] }, BASE).ingredients).toEqual(["sugar"]);
  });

  it("normalizes human durations to ISO-8601", () => {
    const c = coerceRecipe({ prepTime: "1 hr 30 mins", cookTime: "PT12M", totalTime: "nope" }, BASE);
    expect(c.prepTime).toBe("PT1H30M");
    expect(c.cookTime).toBe("PT12M");
    expect(c.totalTime).toBeUndefined();
  });
});
