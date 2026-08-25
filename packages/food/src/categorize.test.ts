import { beforeAll, describe, expect, it } from "vitest";
import { type Lexicon, categorizeWith, diceCoefficient, loadLexicon } from "./categorize";

/**
 * The cascade steps are pinned against a hand-built fixture rather than the real
 * lexicon. With 6,000+ index keys, an entry added by the synonym pass can move a
 * phrase from step 3 to step 1 without changing its answer, and a test that
 * asserted the *step* would fail for a change that improved the product. The
 * fixture makes each step reachable exactly once; the real lexicon is then
 * tested on outcomes, which is what actually has to hold.
 */
const FIXTURE: Lexicon = {
  __meta: {},
  foods: {
    "en:chicken-breast": { a: "meat_seafood", n: "chicken breast" },
    "en:chicken-thigh": { a: "meat_seafood", n: "chicken thigh" },
    "en:olive-oil": { a: "pantry", n: "olive oil", s: 1 },
    "en:oil": { a: "pantry", n: "oil", s: 1 },
    "en:peeled-tomatoes": { a: "canned_jarred", n: "peeled tomatoes" },
    "en:cinnamon": { a: "spices", n: "cinnamon", s: 1 },
    "en:water": { a: "beverages", n: "water", x: 1 },
  },
  index: {
    "chicken breast": "en:chicken-breast",
    "chicken thigh": "en:chicken-thigh",
    "olive oil": "en:olive-oil",
    oil: "en:oil",
    "peeled tomatoes": "en:peeled-tomatoes",
    cinnamon: "en:cinnamon",
    water: "en:water",
  },
};

const fixture = (name: string) => categorizeWith(FIXTURE, name);

describe("cascade step 1 — exact", () => {
  it("matches a canonical name", () => {
    expect(fixture("chicken breast")).toMatchObject({ foodSlug: "en:chicken-breast", aisle: "meat_seafood", via: "exact" });
  });

  it("is case-, punctuation- and whitespace-insensitive", () => {
    expect(fixture("Chicken Breast").via).toBe("exact");
    expect(fixture("  chicken   breast  ").foodSlug).toBe("en:chicken-breast");
  });
});

describe("cascade step 2 — singularization", () => {
  it("matches a plural against a singular entry", () => {
    expect(fixture("chicken breasts")).toMatchObject({ foodSlug: "en:chicken-breast", via: "singular" });
  });
});

describe("cascade step 3 — left-trim modifiers", () => {
  it("drops leading modifiers one at a time until something matches", () => {
    expect(fixture("boneless skinless chicken breasts")).toMatchObject({ foodSlug: "en:chicken-breast", via: "trimmed" });
  });

  it("takes the longest surviving suffix, not the shortest", () => {
    // `olive oil` must win over the bare `oil` that also matches.
    expect(fixture("really good italian olive oil").foodSlug).toBe("en:olive-oil");
  });

  it("keeps the ORIGINAL name as the identity even when it trimmed to match", () => {
    expect(fixture("boneless skinless chicken breasts").nameNorm).toBe("boneless skinless chicken breasts");
  });
});

describe("cascade step 4 — head-noun suffix", () => {
  it("reaches a plural lexicon entry that singularization walks past", () => {
    // `canned peeled tomatoes` singularizes to `… peeled tomato`, so step 3 can
    // never find the entry, which is spelled `peeled tomatoes`.
    expect(fixture("canned peeled tomatoes")).toMatchObject({ foodSlug: "en:peeled-tomatoes", via: "suffix" });
  });
});

describe("cascade step 5 — fuzzy", () => {
  it("catches a typo in a food that trimming cannot rescue", () => {
    expect(fixture("cinamon")).toMatchObject({ foodSlug: "en:cinnamon", via: "fuzzy" });
  });

  it("refuses to guess at a short word", () => {
    expect(fixture("zzq").foodSlug).toBeNull();
  });
});

describe("cascade step 6 — miss", () => {
  it("falls back to normalized-name identity and the `other` aisle", () => {
    expect(fixture("flibbertigibbet paste")).toMatchObject({ foodSlug: null, nameNorm: "flibbertigibbet paste", aisle: "other", via: "miss" });
  });

  it("returns a miss for an empty name rather than throwing", () => {
    expect(fixture("").foodSlug).toBeNull();
    expect(fixture("   ").foodSlug).toBeNull();
  });
});

// --- the real lexicon ----------------------------------------------------

let lexicon: Lexicon;
const match = (name: string) => categorizeWith(lexicon, name);

beforeAll(async () => {
  lexicon = await loadLexicon();
});

describe("the generated lexicon", () => {
  it("loads with its provenance intact", () => {
    expect(lexicon.__meta.source).toBe("Open Food Facts");
    expect(lexicon.__meta.license).toBe("ODbL-1.0");
    expect(lexicon.__meta.sourceCommit).toEqual(expect.any(String));
  });

  it("has foods and an index of a sane size", () => {
    expect(Object.keys(lexicon.foods).length).toBeGreaterThan(3000);
    expect(Object.keys(lexicon.index).length).toBeGreaterThan(Object.keys(lexicon.foods).length);
  });

  it("points every index key at a food that exists", () => {
    for (const [key, id] of Object.entries(lexicon.index)) {
      if (!lexicon.foods[id]) throw new Error(`index key ${key} points at missing food ${id}`);
    }
  });

  it("gives every food a known aisle", () => {
    const aisles = new Set(Object.values(lexicon.foods).map((f) => f.a));
    expect([...aisles].every((a) => typeof a === "string" && a.length > 0)).toBe(true);
  });
});

describe("real-lexicon matching", () => {
  it("matches taxonomy names and synonyms", () => {
    expect(match("chicken breast").foodSlug).toBe("en:chicken-breast");
    expect(match("chicken breast meat").foodSlug).toBe("en:chicken-breast");
  });

  it("matches synonyms the recipe-language pass added", () => {
    expect(match("all-purpose flour").foodSlug).toBe("en:wheat-flour");
    expect(match("scallions").foodSlug).toBe(match("spring onion").foodSlug);
    expect(match("cilantro").foodSlug).toBe(match("coriander leaf").foodSlug);
    expect(match("garbanzo beans").foodSlug).toBe(match("chickpea").foodSlug);
  });

  it("matches a food the taxonomy has no node for", () => {
    expect(match("baking soda")).toMatchObject({ foodSlug: "buttery:baking-soda", aisle: "baking", isStaple: true });
  });

  it("resolves real recipe phrasing down to the food", () => {
    expect(match("boneless skinless chicken breasts").foodSlug).toBe("en:chicken-breast");
    expect(match("extra virgin olive oil").foodSlug).toBe("en:olive-oil");
  });
});

describe("the merges the matcher must refuse", () => {
  it("NEVER merges chicken breast with chicken thigh", () => {
    const breast = match("chicken breast");
    const thigh = match("chicken thigh");
    expect(breast.foodSlug).toBeTruthy();
    expect(thigh.foodSlug).toBeTruthy();
    expect(breast.foodSlug).not.toBe(thigh.foodSlug);
  });

  it("NEVER merges red onion with green onion", () => {
    expect(match("red onion").foodSlug).not.toBe(match("green onion").foodSlug);
  });

  it("NEVER merges heavy cream with sour cream", () => {
    expect(match("heavy cream").foodSlug).not.toBe(match("sour cream").foodSlug);
  });

  it("NEVER merges an unmatched line into a matched food", () => {
    // A null slug falls back to name identity and can only ever meet another
    // null slug with the identical name (plan D6).
    expect(match("flibbertigibbet paste").foodSlug).toBeNull();
  });
});

describe("staples and ignored foods", () => {
  it("flags staples, inherited down the tree", () => {
    expect(match("salt").isStaple).toBe(true);
    expect(match("kosher salt").isStaple).toBe(true);
    expect(match("black pepper").isStaple).toBe(true);
    expect(match("olive oil").isStaple).toBe(true);
  });

  it("honours a carve-out beneath a staple node", () => {
    expect(match("butter").isStaple).toBe(false);
  });

  it("flags water as ignored but not the waters people buy", () => {
    expect(match("water").isIgnored).toBe(true);
    expect(match("coconut water").isIgnored).toBe(false);
  });
});

describe("aisle assignment by inheritance", () => {
  it.each([
    ["chicken breast", "meat_seafood"],
    ["cheddar", "dairy_eggs"],
    ["carrot", "produce"],
    ["cinnamon", "spices"],
    ["olive oil", "pantry"],
    ["baking soda", "baking"],
  ])("puts %s in %s", (name, aisle) => {
    expect(match(name).aisle).toBe(aisle);
  });
});

describe("diceCoefficient", () => {
  it("is 1 for identical strings and 0 for disjoint ones", () => {
    expect(diceCoefficient("chicken", "chicken")).toBe(1);
    expect(diceCoefficient("ab", "xy")).toBe(0);
  });

  it("counts repeated bigrams as a multiset, not a set", () => {
    expect(diceCoefficient("banana", "anana")).toBeLessThan(1);
  });

  it("scores a typo well above a different food", () => {
    const typo = diceCoefficient("cinnamon", "cinamon");
    const different = diceCoefficient("chicken breast", "chicken thigh");
    expect(typo).toBeGreaterThan(0.9);
    expect(different).toBeLessThan(0.7);
    expect(typo).toBeGreaterThan(different);
  });
});
