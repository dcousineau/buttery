import { describe, expect, it } from "vitest";
import { formatUS, mergeKey, renderQuantity, resolveUnit, toBaseQuantity, unitLabel } from "./units";

describe("resolveUnit", () => {
  it("resolves convertible mass units to a shared dimension with no merge pin", () => {
    for (const written of ["lb", "lbs", "Pounds", "pound", "LB."]) {
      const unit = resolveUnit(written);
      expect(unit.dim).toBe("mass");
      expect(unit.id).toBe("lb");
      expect(unit.mergeUnit).toBeNull();
    }
  });

  it("resolves convertible volume units the same way", () => {
    for (const written of ["cup", "cups", "C", "c."]) {
      expect(resolveUnit(written).id).toBe("cup");
    }
    expect(resolveUnit("tablespoons").id).toBe("tbsp");
    expect(resolveUnit("tsp").dim).toBe("volume");
  });

  it("treats a missing unit as a bare count that merges freely", () => {
    const unit = resolveUnit(null);
    expect(unit).toMatchObject({ dim: "count", id: null, mergeUnit: null, factor: 1 });
    expect(resolveUnit("")).toMatchObject({ dim: "count", id: null });
    expect(resolveUnit("   ")).toMatchObject({ dim: "count", id: null });
  });

  it("pins discrete units to themselves so they cannot be summed with each other", () => {
    const clove = resolveUnit("cloves");
    expect(clove).toMatchObject({ dim: "count", id: "clove", factor: null, mergeUnit: "clove" });
    expect(resolveUnit("can").mergeUnit).toBe("can");
  });

  it("treats an unrecognised word as a discrete unit rather than discarding it", () => {
    // "2 rashers bacon" must not merge into "100 g bacon".
    const rasher = resolveUnit("rashers");
    expect(rasher.dim).toBe("count");
    expect(rasher.mergeUnit).toBe("rashers");
    expect(rasher.factor).toBeNull();
  });

  it("flags metric units so totals render back in the system they arrived in", () => {
    expect(resolveUnit("g").metric).toBe(true);
    expect(resolveUnit("kg").metric).toBe(true);
    expect(resolveUnit("ml").metric).toBe(true);
    expect(resolveUnit("lb").metric).toBe(false);
    expect(resolveUnit("cup").metric).toBe(false);
  });
});

describe("mergeKey (plan D5)", () => {
  it("gives pounds and ounces the same key, so they merge", () => {
    expect(mergeKey(resolveUnit("lb"))).toBe(mergeKey(resolveUnit("oz")));
  });

  it("gives cups and tablespoons the same key, so they merge", () => {
    expect(mergeKey(resolveUnit("cup"))).toBe(mergeKey(resolveUnit("tbsp")));
  });

  it("separates mass from a bare count — 1 lb chicken is not 2 chickens", () => {
    expect(mergeKey(resolveUnit("lb"))).not.toBe(mergeKey(resolveUnit(null)));
  });

  it("separates two different discrete units", () => {
    expect(mergeKey(resolveUnit("can"))).not.toBe(mergeKey(resolveUnit("clove")));
  });

  it("separates a discrete unit from a bare count — 2 cans is not 2 whole", () => {
    expect(mergeKey(resolveUnit("can"))).not.toBe(mergeKey(resolveUnit(null)));
  });
});

describe("toBaseQuantity", () => {
  it("converts to grams and millilitres", () => {
    expect(toBaseQuantity(1, resolveUnit("lb"))).toBeCloseTo(453.59237, 4);
    expect(toBaseQuantity(8, resolveUnit("oz"))).toBeCloseTo(226.796, 2);
    expect(toBaseQuantity(2, resolveUnit("cups"))).toBeCloseTo(473.176, 2);
  });

  it("counts discrete units at face value", () => {
    expect(toBaseQuantity(3, resolveUnit("cloves"))).toBe(3);
    expect(toBaseQuantity(2, resolveUnit(null))).toBe(2);
  });

  it("passes a missing quantity straight through", () => {
    expect(toBaseQuantity(null, resolveUnit("lb"))).toBeNull();
  });
});

describe("formatUS", () => {
  it("renders eighths as vulgar fractions", () => {
    expect(formatUS(3)).toBe("3");
    expect(formatUS(2.5)).toBe("2½");
    expect(formatUS(0.75)).toBe("¾");
    expect(formatUS(0.25)).toBe("¼");
    expect(formatUS(1.125)).toBe("1⅛");
  });
});

describe("renderQuantity", () => {
  it("renders the plan's headline case: 1 lb + 8 oz reads 1 lb 8 oz", () => {
    const total = toBaseQuantity(1, resolveUnit("lb"))! + toBaseQuantity(8, resolveUnit("oz"))!;
    expect(renderQuantity(total, "mass", "lb")).toBe("1 lb 8 oz");
  });

  it("drops a zero ounce remainder", () => {
    expect(renderQuantity(453.59237 * 2, "mass", "lb")).toBe("2 lb");
  });

  it("falls back to ounces below a pound", () => {
    expect(renderQuantity(28.349523 * 6, "mass", "oz")).toBe("6 oz");
  });

  it("keeps metric totals metric rather than converting to pounds", () => {
    expect(renderQuantity(750, "mass", "g")).toBe("750 g");
    expect(renderQuantity(1500, "mass", "kg")).toBe("1.5 kg");
    expect(renderQuantity(1500, "mass", "g")).toBe("1.5 kg");
  });

  it("renders US volume in cups with fractions", () => {
    expect(renderQuantity(236.58824 * 2.5, "volume", "cup")).toBe("2½ cups");
    expect(renderQuantity(236.58824, "volume", "cup")).toBe("1 cup");
  });

  it("pluralizes cups off the fraction it prints, not the raw total", () => {
    // Only an exact 1 is singular: the string says 1⅛, so it says cups.
    expect(renderQuantity(236.58824 * 1.125, "volume", "cup")).toBe("1⅛ cups");
    // And a total that rounds UP to a half still reads plural.
    expect(renderQuantity(236.58824 * 1.45, "volume", "cup")).toBe("1½ cups");
  });

  it("steps down to tablespoons and teaspoons for small volumes", () => {
    expect(renderQuantity(14.786765 * 2, "volume", "tbsp")).toBe("2 tbsp");
    expect(renderQuantity(4.928922, "volume", "tsp")).toBe("1 tsp");
  });

  it("keeps metric volume metric", () => {
    expect(renderQuantity(500, "volume", "ml")).toBe("500 ml");
    expect(renderQuantity(1500, "volume", "l")).toBe("1.5 l");
  });

  it("renders counts with their discrete unit, pluralized", () => {
    expect(renderQuantity(3, "count", "clove")).toBe("3 cloves");
    expect(renderQuantity(1, "count", "clove")).toBe("1 clove");
    expect(renderQuantity(2, "count", null)).toBe("2");
    // A total that rounds to "1" reads as one of the thing, not "1 cloves".
    expect(renderQuantity(1.02, "count", "clove")).toBe("1 clove");
  });
});

describe("unitLabel", () => {
  it("pluralizes on the quantity", () => {
    expect(unitLabel("clove", 1)).toBe("clove");
    expect(unitLabel("clove", 3)).toBe("cloves");
    expect(unitLabel(null, 2)).toBeNull();
  });
});
