import { describe, expect, it } from "vitest";
import { formatUS, parseServes, scaleIngredient, scaleIngredients } from "./recipe-scale";

/**
 * Ingredient scale & convert (plan §10). Covers each accepted quantity form,
 * each conversion direction, the metric-rounding rule, US eighth-fraction
 * formatting, and the pass-through cases (no quantity, non-convertible units).
 */

describe("formatUS", () => {
  it("rounds values >= 10 to whole numbers", () => {
    expect(formatUS(10)).toBe("10");
    expect(formatUS(12.4)).toBe("12");
    expect(formatUS(15.9)).toBe("16");
  });

  it("renders values < 10 to the nearest eighth as unicode fractions", () => {
    expect(formatUS(1.5)).toBe("1½");
    expect(formatUS(0.75)).toBe("¾");
    expect(formatUS(2.125)).toBe("2⅛");
    expect(formatUS(0.25)).toBe("¼");
    expect(formatUS(3)).toBe("3");
  });

  it("promotes a rounded-up eighth to the next whole number", () => {
    // 1.95 → nearest eighth is 8/8 → 2.
    expect(formatUS(1.95)).toBe("2");
  });

  it("renders a bare zero for a sub-eighth value", () => {
    expect(formatUS(0)).toBe("0");
    expect(formatUS(0.05)).toBe("0");
  });
});

describe("scaleIngredient — quantity forms (US, factor 1)", () => {
  it("integer", () => {
    expect(scaleIngredient("2 eggs", 1, false)).toBe("2 eggs");
  });
  it("decimal", () => {
    expect(scaleIngredient("1.5 cups flour", 1, false)).toBe("1½ cups flour");
  });
  it("ascii fraction", () => {
    expect(scaleIngredient("1/2 cup sugar", 1, false)).toBe("½ cup sugar");
  });
  it("unicode fraction", () => {
    expect(scaleIngredient("½ tsp salt", 1, false)).toBe("½ tsp salt");
  });
  it("integer + unicode fraction", () => {
    expect(scaleIngredient("1¼ cups milk", 1, false)).toBe("1¼ cups milk");
  });
  it("integer + spaced unicode fraction", () => {
    expect(scaleIngredient("1 ½ cups milk", 1, false)).toBe("1½ cups milk");
  });
});

describe("scaleIngredient — scaling by factor", () => {
  it("doubles an integer count", () => {
    expect(scaleIngredient("2 eggs", 2, false)).toBe("4 eggs");
  });
  it("halves a fraction", () => {
    expect(scaleIngredient("1/2 cup sugar", 0.5, false)).toBe("¼ cup sugar");
  });
  it("scales to a mixed number", () => {
    expect(scaleIngredient("1 cup rice", 1.5, false)).toBe("1½ cup rice");
  });
  it("scales past 10 to a whole number", () => {
    expect(scaleIngredient("4 cups broth", 3, false)).toBe("12 cups broth");
  });
});

describe("scaleIngredient — pass-through", () => {
  it("passes a line with no leading quantity through unchanged", () => {
    expect(scaleIngredient("Lemon, to finish", 2, false)).toBe("Lemon, to finish");
    expect(scaleIngredient("A pot of boiling water", 2, true)).toBe("A pot of boiling water");
  });
  it("re-emits a non-convertible unit verbatim (US)", () => {
    expect(scaleIngredient("1 can coconut milk", 2, false)).toBe("2 can coconut milk");
    expect(scaleIngredient("2 sprigs thyme", 1, false)).toBe("2 sprigs thyme");
  });
  it("re-emits a non-convertible unit verbatim (metric)", () => {
    // "head" is not convertible, so metric leaves it alone (still scales count).
    expect(scaleIngredient("1 head garlic", 2, true)).toBe("2 head garlic");
  });
});

describe("scaleIngredient — US → metric", () => {
  it("cups → ml (nearest 10 above 100)", () => {
    // 1 cup = 236.6 ml → round to nearest 10 → 240.
    expect(scaleIngredient("1 cup water", 1, true)).toBe("240 ml water");
  });
  it("tbsp → ml (nearest 5)", () => {
    // 1 tbsp = 14.8 → nearest 5 → 15.
    expect(scaleIngredient("1 tbsp oil", 1, true)).toBe("15 ml oil");
  });
  it("tsp → ml (nearest 5)", () => {
    // 1 tsp = 4.9 → nearest 5 → 5.
    expect(scaleIngredient("1 tsp vanilla", 1, true)).toBe("5 ml vanilla");
  });
  it("lb → g (nearest 10 above 100)", () => {
    // 1 lb = 453.6 → nearest 10 → 450.
    expect(scaleIngredient("1 lb beef", 1, true)).toBe("450 g beef");
  });
  it("oz → g (nearest 5)", () => {
    // 2 oz = 56.7 → nearest 5 → 55.
    expect(scaleIngredient("2 oz butter", 1, true)).toBe("55 g butter");
  });
  it("scales before converting", () => {
    // 2 cups = 473.2 → nearest 10 → 470.
    expect(scaleIngredient("1 cup water", 2, true)).toBe("470 ml water");
  });
  it("passes already-metric units through, rounded", () => {
    expect(scaleIngredient("200 g flour", 1, true)).toBe("200 g flour");
    expect(scaleIngredient("250 ml milk", 1, true)).toBe("250 ml milk");
  });
});

describe("scaleIngredient — metric → US", () => {
  it("g → oz", () => {
    // 28.35 g = 1 oz.
    expect(scaleIngredient("28 g butter", 1, false)).toBe("1 oz butter");
  });
  it("ml → cups", () => {
    // 236.6 ml = 1 cup.
    expect(scaleIngredient("237 ml water", 1, false)).toBe("1 cups water");
  });
});

describe("scaleIngredients", () => {
  it("maps over a list", () => {
    expect(scaleIngredients(["2 eggs", "Salt, to taste"], 2, false)).toEqual(["4 eggs", "Salt, to taste"]);
  });
});

describe("parseServes", () => {
  it("parses the leading integer of a free-text yield", () => {
    expect(parseServes("8 servings")).toBe(8);
    expect(parseServes("Serves 4")).toBe(4);
    expect(parseServes("12")).toBe(12);
  });
  it("returns null when there is no integer", () => {
    expect(parseServes("a loaf")).toBeNull();
    expect(parseServes("")).toBeNull();
    expect(parseServes(null)).toBeNull();
    expect(parseServes(undefined)).toBeNull();
  });
});
