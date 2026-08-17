import { describe, expect, it } from "vitest";
import { parseIngredientLine, parseIngredientLines } from "./parse";

describe("parseIngredientLine — quantities and units", () => {
  it("reads a plain quantity and unit", () => {
    expect(parseIngredientLine("1 lb chicken breast")).toMatchObject({
      quantity: 1,
      unit: "lb",
      unitDim: "mass",
      mergeUnit: null,
      name: "chicken breast",
    });
  });

  it("reads fractions, mixed numbers and vulgar fractions", () => {
    expect(parseIngredientLine("1/2 cup all-purpose flour").quantity).toBe(0.5);
    expect(parseIngredientLine("1½ tsp ground cumin").quantity).toBe(1.5);
    expect(parseIngredientLine("¼ cup olive oil").quantity).toBe(0.25);
    expect(parseIngredientLine("2 1/4 cups milk").quantity).toBe(2.25);
  });

  it("keeps both endpoints of a range", () => {
    expect(parseIngredientLine("2 to 3 cups whole milk")).toMatchObject({ quantity: 2, quantityMax: 3, unit: "cup" });
  });

  it("converts to base units", () => {
    expect(parseIngredientLine("1 lb beef").quantityBase).toBeCloseTo(453.59237, 4);
    expect(parseIngredientLine("8 oz beef").quantityBase).toBeCloseTo(226.796, 2);
    expect(parseIngredientLine("3 cloves garlic").quantityBase).toBe(3);
  });

  it("applies scale before anything else (plan §5.3)", () => {
    const doubled = parseIngredientLine("1 lb chicken breast", { scale: 2 });
    expect(doubled.quantity).toBe(2);
    expect(doubled.quantityBase).toBeCloseTo(453.59237 * 2, 3);
  });

  it("does not treat a size word as a unit", () => {
    // "3 larges" would never merge with "2 eggs" from the next recipe.
    const parsed = parseIngredientLine("3 large eggs");
    expect(parsed.quantity).toBe(3);
    expect(parsed.unit).toBeNull();
    expect(parsed.unitDim).toBe("count");
  });

  it("finds the unit behind a parenthetical", () => {
    // Left in place, "(14.5 oz)" hides `can` from the parser entirely.
    expect(parseIngredientLine("1 (14.5 oz) can diced tomatoes")).toMatchObject({
      quantity: 1,
      unit: "can",
      mergeUnit: "can",
      name: "diced tomatoes",
      note: "14.5 oz",
    });
  });

  it("gives a quantity-less line no quantity at all", () => {
    expect(parseIngredientLine("Kosher salt, to taste")).toMatchObject({ quantity: null, quantityBase: null, name: "Kosher salt" });
    expect(parseIngredientLine("Freshly ground pepper, as needed").quantity).toBeNull();
  });
});

describe("parseIngredientLine — names and notes", () => {
  it("strips a trailing prep clause into the note", () => {
    expect(parseIngredientLine("2 cloves garlic, finely minced")).toMatchObject({ name: "garlic", note: "finely minced" });
  });

  it("strips leading adverbs but keeps modifiers that are part of the food", () => {
    // "ground beef" is a different thing to buy than "beef".
    expect(parseIngredientLine("500 g ground beef").name).toBe("ground beef");
    expect(parseIngredientLine("1½ tsp freshly ground black pepper")).toMatchObject({ name: "ground black pepper", note: "freshly" });
    expect(parseIngredientLine("2 tablespoons unsalted butter, melted").name).toBe("unsalted butter");
  });

  it("keeps a parenthetical as a note rather than dropping it", () => {
    expect(parseIngredientLine("2 chicken breasts (about 1 lb)").note).toBe("about 1 lb");
  });

  it("preserves the raw line verbatim for the source snapshot", () => {
    const raw = "  2 cloves garlic, finely minced  ";
    expect(parseIngredientLine(raw).raw).toBe(raw);
  });
});

describe("parseIngredientLine — group headers", () => {
  it("flags a 'For the …' heading", () => {
    expect(parseIngredientLine("For the sauce:").isGroupHeader).toBe(true);
  });

  it("flags a bare heading the library's vocabulary would miss", () => {
    expect(parseIngredientLine("Sauce:").isGroupHeader).toBe(true);
    expect(parseIngredientLine("To serve:").isGroupHeader).toBe(true);
  });

  it("does not mistake an ingredient for a heading", () => {
    expect(parseIngredientLine("2 cups flour").isGroupHeader).toBe(false);
  });
});

describe("parseIngredientLines", () => {
  it("drops headings and empty names, keeping real lines in order", () => {
    const rows = parseIngredientLines(["For the filling:", "1 lb chicken breast", "", "2 cloves garlic", "To serve:"]);
    expect(rows.map((r) => r.name)).toEqual(["chicken breast", "garlic"]);
  });

  it("never throws on junk, and never silently drops a line it cannot read", () => {
    const rows = parseIngredientLines(["???", "a handful of whatever"]);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.name.length).toBeGreaterThan(0);
  });
});
