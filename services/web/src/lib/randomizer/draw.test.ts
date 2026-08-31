import { describe, expect, it } from "vitest";
import { clearFilters, countSheetFilters, defaultFilters, draw, hasActiveFilters, isResultStale, toPoolFilters } from "./draw";

// Tiny fixtures — this module only cares about `recipeId`.
function pool(n: number) {
  return Array.from({ length: n }, (_, i) => ({ recipeId: `r${i}` }));
}

// A stubbed rng lets every test assert an EXACT selection, not a statistical
// shape. `rng(v)` returns a generator that always yields `v`.
function rng(v: number) {
  return () => v;
}

describe("draw", () => {
  it("picks uniformly: rng()=0 always lands on index 0", () => {
    const p = pool(5);
    const result = draw(p, null, rng(0));
    expect(result).toEqual({ status: "drawn", card: p[0], onlyMatch: false });
  });

  it("picks uniformly: every index is reachable via floor(rng() * n)", () => {
    const p = pool(4);
    // 0, .25, .5, .75 map to indices 0, 1, 2, 3 exactly.
    expect(draw(p, null, rng(0))).toEqual({ status: "drawn", card: p[0], onlyMatch: false });
    expect(draw(p, null, rng(0.25))).toEqual({ status: "drawn", card: p[1], onlyMatch: false });
    expect(draw(p, null, rng(0.5))).toEqual({ status: "drawn", card: p[2], onlyMatch: false });
    expect(draw(p, null, rng(0.75))).toEqual({ status: "drawn", card: p[3], onlyMatch: false });
  });

  it("picks uniformly: rng()→1 (just under) lands on the last index", () => {
    const p = pool(4);
    expect(draw(p, null, rng(0.9999999))).toEqual({ status: "drawn", card: p[3], onlyMatch: false });
  });

  it("clamps a hostile rng that returns exactly 1 to the last index, never undefined", () => {
    const p = pool(3);
    const result = draw(p, null, rng(1));
    expect(result.status).toBe("drawn");
    expect(result.status === "drawn" && result.card).toBe(p[2]);
  });

  it("defaults rng to Math.random when omitted", () => {
    const p = pool(3);
    const result = draw(p, null);
    expect(result.status).toBe("drawn");
    expect(result.status === "drawn" && p.includes(result.card)).toBe(true);
  });

  it("§5.4: an empty pool is a state, not an error", () => {
    expect(draw([], null, rng(0))).toEqual({ status: "empty" });
    expect(draw([], "r0", rng(0))).toEqual({ status: "empty" });
  });

  it("§5.4: a single-match pool is drawable and flagged onlyMatch", () => {
    const p = pool(1);
    const result = draw(p, null, rng(0));
    expect(result).toEqual({ status: "drawn", card: p[0], onlyMatch: true });
  });

  it("§5.3: pool size 1 re-draws the same recipe when it is excluded (no-repeat can't empty the pool)", () => {
    const p = pool(1);
    const result = draw(p, "r0", rng(0));
    expect(result).toEqual({ status: "drawn", card: p[0], onlyMatch: true });
  });

  it("§5.3: pool size 2 excludes the last result, leaving exactly one candidate", () => {
    const p = pool(2);
    // rng(0.9) would normally pick index 1 out of 2, but r1 is excluded, so
    // the sole remaining candidate (r0) must come back regardless of rng.
    const result = draw(p, "r1", rng(0.9));
    expect(result).toEqual({ status: "drawn", card: p[0], onlyMatch: false });
  });

  it("§5.3: pool size N excludes the last result from the candidate set", () => {
    const p = pool(5);
    // With r2 excluded, the remaining candidates in order are r0,r1,r3,r4.
    // rng(0.5) → floor(0.5*4)=2 → the third remaining candidate, r3.
    const result = draw(p, "r2", rng(0.5));
    expect(result).toEqual({ status: "drawn", card: p[3], onlyMatch: false });
  });

  it("§5.3: excludeRecipeId=null draws from the full pool (first draw, nothing to exclude yet)", () => {
    const p = pool(3);
    const result = draw(p, null, rng(0.9999999));
    expect(result).toEqual({ status: "drawn", card: p[2], onlyMatch: false });
  });

  it("§5.3: excluding an id not present in the pool is a no-op on the candidate set", () => {
    const p = pool(3);
    const result = draw(p, "not-in-pool", rng(0));
    expect(result).toEqual({ status: "drawn", card: p[0], onlyMatch: false });
  });
});

describe("isResultStale", () => {
  it("is not stale when nothing has been drawn yet", () => {
    expect(isResultStale(null, pool(3))).toBe(false);
  });

  it("is not stale when the drawn recipe is still in the pool", () => {
    expect(isResultStale("r1", pool(3))).toBe(false);
  });

  it("is stale when the drawn recipe fell out of the pool", () => {
    expect(isResultStale("r9", pool(3))).toBe(true);
  });

  it("is stale against an empty pool", () => {
    expect(isResultStale("r0", [])).toBe(true);
  });
});

describe("defaultFilters / clearFilters", () => {
  it("§5.5: defaults are not all-empty — skipRecentDays=14, includeUntimed=off", () => {
    expect(defaultFilters()).toEqual({
      source: "box",
      collectionId: null,
      favoritesOnly: false,
      cuisine: null,
      maxCookMinutes: null,
      includeUntimed: false,
      ingredient: "",
      mealType: null,
      diets: [],
      avoidAllergens: [],
      spiceLevel: null,
      skipRecentDays: 14,
    });
  });

  it("clears every filter back to the non-empty defaults", () => {
    const dirty = {
      source: "box" as const,
      collectionId: "c1",
      favoritesOnly: true,
      cuisine: "italian",
      maxCookMinutes: 30,
      includeUntimed: true,
      ingredient: "garlic",
      mealType: "dinner",
      diets: ["vegan"],
      avoidAllergens: ["peanut"],
      spiceLevel: "hot",
      skipRecentDays: 7,
    };
    expect(clearFilters(dirty)).toEqual(defaultFilters());
  });

  it("preserves `source` across a clear — clearing filters must not un-widen the pool", () => {
    const dirty = { ...defaultFilters(), source: "corpus" as const, cuisine: "thai" };
    expect(clearFilters(dirty)).toEqual({ ...defaultFilters(), source: "corpus" });
  });
});

describe("hasActiveFilters", () => {
  it("is false against the defaults", () => {
    expect(hasActiveFilters(defaultFilters())).toBe(false);
  });

  it("is false when only `source` differs from default (scope, not a filter)", () => {
    expect(hasActiveFilters({ ...defaultFilters(), source: "corpus" })).toBe(false);
  });

  it("is true when any single filter differs from default", () => {
    expect(hasActiveFilters({ ...defaultFilters(), collectionId: "c1" })).toBe(true);
    expect(hasActiveFilters({ ...defaultFilters(), favoritesOnly: true })).toBe(true);
    expect(hasActiveFilters({ ...defaultFilters(), cuisine: "thai" })).toBe(true);
    expect(hasActiveFilters({ ...defaultFilters(), maxCookMinutes: 20 })).toBe(true);
    expect(hasActiveFilters({ ...defaultFilters(), includeUntimed: true })).toBe(true);
    expect(hasActiveFilters({ ...defaultFilters(), ingredient: "egg" })).toBe(true);
    expect(hasActiveFilters({ ...defaultFilters(), mealType: "snack" })).toBe(true);
    expect(hasActiveFilters({ ...defaultFilters(), diets: ["vegan"] })).toBe(true);
    expect(hasActiveFilters({ ...defaultFilters(), avoidAllergens: ["peanut"] })).toBe(true);
    expect(hasActiveFilters({ ...defaultFilters(), spiceLevel: "mild" })).toBe(true);
    expect(hasActiveFilters({ ...defaultFilters(), skipRecentDays: 30 })).toBe(true);
    expect(hasActiveFilters({ ...defaultFilters(), skipRecentDays: null })).toBe(true);
  });
});

describe("countSheetFilters", () => {
  it("is 0 against the defaults", () => {
    expect(countSheetFilters(defaultFilters())).toBe(0);
  });

  it("counts each of the five sheet controls independently", () => {
    expect(countSheetFilters({ ...defaultFilters(), diets: ["vegan"] })).toBe(1);
    expect(countSheetFilters({ ...defaultFilters(), avoidAllergens: ["peanut"] })).toBe(1);
    expect(countSheetFilters({ ...defaultFilters(), spiceLevel: "hot" })).toBe(1);
    expect(countSheetFilters({ ...defaultFilters(), collectionId: "c1" })).toBe(1);
    expect(countSheetFilters({ ...defaultFilters(), includeUntimed: true })).toBe(1);
  });

  it("counts a control once regardless of how many slugs are selected inside it", () => {
    expect(countSheetFilters({ ...defaultFilters(), diets: ["vegan", "vegetarian", "keto"] })).toBe(1);
  });

  it("sums independent controls, and ignores non-sheet filters entirely", () => {
    const filters = {
      ...defaultFilters(),
      diets: ["vegan"],
      spiceLevel: "hot",
      collectionId: "c1",
      // Inline chips — not part of the sheet, must not affect the count.
      cuisine: "thai",
      maxCookMinutes: 20,
      favoritesOnly: true,
      skipRecentDays: 30,
    };
    expect(countSheetFilters(filters)).toBe(3);
  });
});

describe("toPoolFilters", () => {
  it("maps the defaults to the wire shape: nulls/empty-string become undefined, empty arrays pass through, skipRecentDays=14 stays 14", () => {
    expect(toPoolFilters(defaultFilters())).toEqual({
      source: "box",
      collectionId: undefined,
      favoritesOnly: false,
      cuisine: undefined,
      maxCookMinutes: undefined,
      includeUntimed: false,
      ingredient: undefined,
      mealType: undefined,
      diets: [],
      avoidAllergens: [],
      spiceLevel: undefined,
      skipRecentDays: 14,
    });
  });

  it("passes every set field straight through", () => {
    const state = {
      ...defaultFilters(),
      source: "corpus" as const,
      collectionId: "c1",
      favoritesOnly: true,
      cuisine: "thai",
      maxCookMinutes: 30,
      includeUntimed: true,
      ingredient: "garlic",
      mealType: "dinner",
      diets: ["vegan", "keto"],
      avoidAllergens: ["peanut"],
      spiceLevel: "hot",
      skipRecentDays: 7,
    };
    expect(toPoolFilters(state)).toEqual({
      source: "corpus",
      collectionId: "c1",
      favoritesOnly: true,
      cuisine: "thai",
      maxCookMinutes: 30,
      includeUntimed: true,
      ingredient: "garlic",
      mealType: "dinner",
      diets: ["vegan", "keto"],
      avoidAllergens: ["peanut"],
      spiceLevel: "hot",
      skipRecentDays: 7,
    });
  });

  it("§4.1: skipRecentDays=null (explicit off) is NOT coerced to undefined — the two mean different things on the wire", () => {
    expect(toPoolFilters({ ...defaultFilters(), skipRecentDays: null }).skipRecentDays).toBeNull();
  });

  it("a whitespace-only ingredient string is treated the same as empty — unset, not a substring search for spaces", () => {
    expect(toPoolFilters({ ...defaultFilters(), ingredient: "   " }).ingredient).toBeUndefined();
  });
});
