import { beforeAll, describe, expect, it } from "vitest";
import type { Lexicon } from "@buttery/food/categorize";
import { loadLexicon } from "@buttery/food/categorize";
import { mergeManualItem, mergeRecipeLines } from "./merge";

let lexicon: Lexicon;

beforeAll(async () => {
  lexicon = await loadLexicon();
});

const rowsFor = (...recipes: Array<{ recipeId: string; lines: string[]; scale?: number }>) => mergeRecipeLines(lexicon, recipes);

describe("the brief's headline case", () => {
  it("merges 1 lb and 8 oz of chicken breast into one row reading 1 lb 8 oz", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["1 lb chicken breast"] }, { recipeId: "r2", lines: ["8 oz chicken breast"] });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      foodSlug: "en:chicken-breast",
      aisle: "meat_seafood",
      unitDim: "mass",
      quantityDisplay: "1 lb 8 oz",
    });
  });

  it("names both source recipes under the merged row", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["1 lb chicken breast"] }, { recipeId: "r2", lines: ["8 oz chicken breast"] });

    expect(rows[0].sources).toHaveLength(2);
    expect(rows[0].sources.map((s) => s.recipeId)).toEqual(["r1", "r2"]);
    // The raw line is snapshotted so the row survives its recipe going away.
    expect(rows[0].sources.map((s) => s.rawText)).toEqual(["1 lb chicken breast", "8 oz chicken breast"]);
  });
});

describe("what must NOT merge (plan D5)", () => {
  it("keeps 1 lb chicken breast and 2 chicken breasts as two rows", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["1 lb chicken breast"] }, { recipeId: "r2", lines: ["2 chicken breasts"] });

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.unitDim).sort()).toEqual(["count", "mass"]);
  });

  it("keeps two different discrete units apart", () => {
    // 2 cans of tomatoes and 3 whole tomatoes have no common total.
    const rows = rowsFor({ recipeId: "r1", lines: ["2 cans peeled tomatoes"] }, { recipeId: "r2", lines: ["3 peeled tomatoes"] });
    expect(rows).toHaveLength(2);
  });

  it("keeps two different foods apart even when they share a head noun", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["1 lb chicken breast"] }, { recipeId: "r2", lines: ["1 lb chicken thigh"] });
    expect(rows).toHaveLength(2);
  });

  it("never merges an unmatched line into a matched food", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["2 cups flibbertigibbet paste"] }, { recipeId: "r2", lines: ["1 cup flour"] });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.foodSlug === null)).toBeTruthy();
  });
});

describe("what does merge", () => {
  it("merges cups and tablespoons, which share a dimension and convert", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["1 cup whole milk"] }, { recipeId: "r2", lines: ["2 tbsp whole milk"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].quantityBase).toBeCloseTo(236.58824 + 2 * 14.786765, 3);
  });

  it("merges the same discrete unit", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["2 cloves garlic"] }, { recipeId: "r2", lines: ["3 cloves garlic"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].quantityDisplay).toBe("5 cloves");
  });

  it("merges two spellings of the same food through the lexicon", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["1 bunch scallions"] }, { recipeId: "r2", lines: ["1 bunch green onions"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].sources).toHaveLength(2);
  });

  it("keeps metric totals metric", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["500 g ground beef"] }, { recipeId: "r2", lines: ["250 g ground beef"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].quantityDisplay).toBe("750 g");
  });
});

describe("quantity-less contributions", () => {
  it("joins an existing row as a source without moving the total", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["2 tsp salt"] }, { recipeId: "r2", lines: ["Salt, to taste"] });

    const salt = rows.find((r) => r.nameNorm.includes("salt"));
    expect(salt).toBeTruthy();
    expect(salt!.sources).toHaveLength(2);
    // The total is still just the 2 tsp that were actually specified.
    expect(salt!.quantityBase).toBeCloseTo(2 * 4.928922, 4);
  });

  it("still produces a row when NOTHING carried a quantity", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["Salt, to taste"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].quantityBase).toBeNull();
    expect(rows[0].quantityDisplay).toBeNull();
  });
});

describe("scale (plan D4 / §5.3)", () => {
  it("multiplies a recipe's quantities before merging", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["1 lb chicken breast"], scale: 2 });
    expect(rows[0].quantityBase).toBeCloseTo(453.59237 * 2, 3);
    expect(rows[0].quantityDisplay).toBe("2 lb");
  });

  it("applies each recipe's own scale independently", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["1 lb chicken breast"], scale: 2 }, { recipeId: "r2", lines: ["1 lb chicken breast"], scale: 0.5 });
    expect(rows).toHaveLength(1);
    expect(rows[0].quantityBase).toBeCloseTo(453.59237 * 2.5, 3);
  });

  it("records the scale on each source row", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["1 lb chicken breast"], scale: 3 });
    expect(rows[0].sources[0].scale).toBe(3);
  });
});

describe("ranges", () => {
  it("keeps both endpoints and renders them", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["2 to 3 cups whole milk"] });
    expect(rows[0].quantityDisplay).toContain("–");
    expect(rows[0].quantityDisplay).toBe("2 cups – 3 cups");
  });

  it("does not render a range when the endpoints are equal", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["2 cups whole milk"] });
    expect(rows[0].quantityDisplay).toBe("2 cups");
  });
});

describe("presentation", () => {
  it("prefers the lexicon's canonical name so spellings converge", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["1 bunch scallions"] });
    expect(rows[0].displayName).toBe(lexicon.foods[rows[0].foodSlug!].n);
  });

  it("keeps the line's own words when the match came from a fallback step", () => {
    // `egg noodles` resolves through `en:noodle` by throwing a word away, and
    // that word was the useful one. A list that says "noodle" is worse.
    const rows = rowsFor({ recipeId: "r1", lines: ["6 oz egg noodles"] });
    expect(rows[0].foodSlug).toBeTruthy();
    expect(rows[0].displayName).toBe("egg noodles");
  });

  it("trims a trailing prep clause off the displayed name", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["1 lb mushrooms, stems discarded, caps thickly sliced"] });
    expect(rows[0].displayName).toBe("mushrooms");
  });

  it("does NOT trim a LEADING modifier that happens to be comma-separated", () => {
    // "boneless, skinless chicken breasts" must not render as "boneless".
    const rows = rowsFor({ recipeId: "r1", lines: ["4 boneless, skinless chicken breasts"] });
    expect(rows[0].foodSlug).toBe("en:chicken-breast");
    expect(rows[0].displayName).toContain("chicken breast");
  });

  it("falls back to the line's own words when nothing matched", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["2 cups flibbertigibbet paste"] });
    expect(rows[0].displayName).toBe("flibbertigibbet paste");
  });

  it("returns rows in first-seen order", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["1 lb chicken breast", "2 cloves garlic", "1 cup flour"] });
    expect(rows.map((r) => r.aisle)).toEqual(["meat_seafood", "produce", "baking"]);
  });

  it("drops group headers rather than listing them as food", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["For the sauce:", "2 cloves garlic"] });
    expect(rows).toHaveLength(1);
  });
});

describe("staples and ignored lines", () => {
  it("marks staple rows so the preview can leave them unchecked", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["2 tsp salt", "1 lb chicken breast"] });
    expect(rows.find((r) => r.isStaple)).toBeTruthy();
    expect(rows.find((r) => r.foodSlug === "en:chicken-breast")!.isStaple).toBe(false);
  });

  it("marks water as ignored when it came from a recipe", () => {
    const rows = rowsFor({ recipeId: "r1", lines: ["4 cups water"] });
    expect(rows[0].isIgnored).toBe(true);
  });
});

describe("mergeManualItem", () => {
  it("parses and categorizes a typed line", () => {
    const row = mergeManualItem(lexicon, "2 lbs chicken breast");
    expect(row).toMatchObject({ foodSlug: "en:chicken-breast", aisle: "meat_seafood", quantityDisplay: "2 lb" });
    expect(row!.sources[0].recipeId).toBeNull();
  });

  it("honours a typed item even when the same word from a recipe is ignored", () => {
    // Typing "water" is a deliberate act; a recipe calling for water is not.
    expect(mergeManualItem(lexicon, "water")!.isIgnored).toBe(false);
  });

  it("accepts a bare name with no quantity", () => {
    const row = mergeManualItem(lexicon, "paper towels");
    expect(row).toBeTruthy();
    expect(row!.quantityBase).toBeNull();
    expect(row!.displayName).toBe("paper towels");
  });

  it("returns null for an empty line", () => {
    expect(mergeManualItem(lexicon, "   ")).toBeNull();
  });
});
