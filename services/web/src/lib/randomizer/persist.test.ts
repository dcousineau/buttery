import { describe, expect, it } from "vitest";
import { defaultFilters, type RandomizerFilterState } from "./draw";
import { parseStoredFilters, randomizerFiltersStorageKey, RANDOMIZER_FILTERS_STORAGE_VERSION, restoreFilters, serializeFilters } from "./persist";

function dirtyState(): RandomizerFilterState {
  return {
    source: "corpus",
    collectionIds: ["c1", "c2"],
    favoritesOnly: true,
    cuisine: "thai",
    maxCookMinutes: 30,
    includeUntimed: false,
    ingredient: "garlic",
    mealType: "dinner",
    diets: ["vegan", "keto"],
    avoidAllergens: ["peanut"],
    spiceLevel: "hot",
    skipRecentDays: 7,
  };
}

describe("randomizerFiltersStorageKey", () => {
  it("is per-household — two households never share a key", () => {
    expect(randomizerFiltersStorageKey("household-a")).not.toBe(randomizerFiltersStorageKey("household-b"));
  });

  it("is stable for the same household", () => {
    expect(randomizerFiltersStorageKey("household-a")).toBe(randomizerFiltersStorageKey("household-a"));
  });
});

describe("serializeFilters", () => {
  it("never includes `source` in the payload", () => {
    const json = serializeFilters(dirtyState());
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, "source")).toBe(false);
  });

  it("carries the current storage version", () => {
    const parsed = JSON.parse(serializeFilters(dirtyState())) as { version: number };
    expect(parsed.version).toBe(RANDOMIZER_FILTERS_STORAGE_VERSION);
  });
});

describe("restoreFilters — the round trip", () => {
  it('round-trips every field except `source`, which always comes back "box"', () => {
    const dirty = dirtyState();
    const restored = restoreFilters(serializeFilters(dirty));
    expect(restored).toEqual({ ...dirty, source: "box" });
  });

  it("restoring the defaults' own serialization is a no-op", () => {
    expect(restoreFilters(serializeFilters(defaultFilters()))).toEqual(defaultFilters());
  });
});

describe("restoreFilters — defensive parsing", () => {
  it("a missing key (null) restores the plain defaults", () => {
    expect(restoreFilters(null)).toEqual(defaultFilters());
  });

  it("an absent key (undefined) restores the plain defaults", () => {
    expect(restoreFilters(undefined)).toEqual(defaultFilters());
  });

  it("an empty string restores the plain defaults", () => {
    expect(restoreFilters("")).toEqual(defaultFilters());
  });

  it("invalid JSON (corrupt blob) never throws and restores defaults", () => {
    expect(() => restoreFilters("{not json")).not.toThrow();
    expect(restoreFilters("{not json")).toEqual(defaultFilters());
  });

  it("a truncated JSON string never throws and restores defaults", () => {
    const truncated = serializeFilters(dirtyState()).slice(0, 20);
    expect(() => restoreFilters(truncated)).not.toThrow();
    expect(restoreFilters(truncated)).toEqual(defaultFilters());
  });

  it("a JSON value that isn't an object (array/number/string/bool) restores defaults", () => {
    expect(restoreFilters("[1,2,3]")).toEqual(defaultFilters());
    expect(restoreFilters("42")).toEqual(defaultFilters());
    expect(restoreFilters('"just a string"')).toEqual(defaultFilters());
    expect(restoreFilters("true")).toEqual(defaultFilters());
    expect(restoreFilters("null")).toEqual(defaultFilters());
  });

  it("a stored shape with no `version` field (pre-this-feature, or hand-edited) restores defaults wholesale", () => {
    const noVersion = JSON.stringify({ diets: ["vegan"], maxCookMinutes: 30 });
    expect(restoreFilters(noVersion)).toEqual(defaultFilters());
  });

  it("a `version` from a future/older release restores defaults wholesale rather than guessing", () => {
    const wrongVersion = JSON.stringify({ version: RANDOMIZER_FILTERS_STORAGE_VERSION + 1, diets: ["vegan"] });
    expect(restoreFilters(wrongVersion)).toEqual(defaultFilters());
  });

  it("fields of the wrong TYPE are dropped individually — sibling fields of the right type still restore", () => {
    const mixed = JSON.stringify({
      version: RANDOMIZER_FILTERS_STORAGE_VERSION,
      maxCookMinutes: "soon", // wrong type — should fall back to default (null)
      collectionIds: "c1", // wrong type (string, not array) — should fall back to default ([])
      diets: ["vegan", 42, "keto"], // wrong type — the whole array is rejected, not just the bad element
      favoritesOnly: "yes", // wrong type — should fall back to default (false)
      cuisine: "thai", // right type — should survive
      spiceLevel: null, // right type (nullable) — should survive as null
    });
    expect(restoreFilters(mixed)).toEqual({
      ...defaultFilters(),
      cuisine: "thai",
      spiceLevel: null,
    });
  });

  it("NaN/Infinity smuggled through a hand-edited numeric literal never survive (JSON itself can't encode them, but a huge finite literal must still parse as a number)", () => {
    const huge = JSON.stringify({ version: RANDOMIZER_FILTERS_STORAGE_VERSION, maxCookMinutes: 999999 });
    expect(restoreFilters(huge).maxCookMinutes).toBe(999999);
  });

  it('`source` inside a stored blob is ignored — restoring never returns anything but "box"', () => {
    const withSource = JSON.stringify({ version: RANDOMIZER_FILTERS_STORAGE_VERSION, source: "corpus", diets: ["vegan"] });
    expect(restoreFilters(withSource).source).toBe("box");
  });

  it("a field added in a later release that this blob predates comes back as ITS default, not undefined", () => {
    // Simulates an old blob that only ever knew about `diets` — every other
    // field (added since) must be present and defaulted, never `undefined`.
    const oldShape = JSON.stringify({ version: RANDOMIZER_FILTERS_STORAGE_VERSION, diets: ["vegan"] });
    const restored = restoreFilters(oldShape);
    expect(restored).toEqual({ ...defaultFilters(), diets: ["vegan"] });
    expect(restored.includeUntimed).toBe(true);
    expect(restored.collectionIds).toEqual([]);
  });
});

describe("parseStoredFilters", () => {
  it("returns an empty object, not a throw, for every malformed input", () => {
    for (const bad of [null, undefined, "", "{broken", "[]", "42", '"str"']) {
      expect(() => parseStoredFilters(bad)).not.toThrow();
      expect(parseStoredFilters(bad)).toEqual({});
    }
  });
});
