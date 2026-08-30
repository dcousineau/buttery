import { describe, expect, it } from "vitest";
import { classify, CLASSIFIER_VERSION, RULES_METHOD } from "#/workflows/recipe-enrichment/classify.ts";
import { ALLERGEN_SLUGS, EMITTED_DIET_SLUGS, TRAIT_MAYBE, TRAIT_NO, TRAIT_YES } from "#/workflows/recipe-enrichment/types.ts";
import type { AllergenVerdict, ClassifierInput, ClassifierLine, DietVerdict, Label } from "#/workflows/recipe-enrichment/types.ts";

/**
 * Pure suite over hand-built `ClassifierInput`s (plan §8.3) — no database, no
 * lexicon load. Every fixture below stands in for a real recipe someone would
 * otherwise have mislabelled by hand: a "vegetarian" curry with fish sauce, a
 * dessert with gelatin, Worcestershire, ghee, lard, marzipan, tahini, soy
 * sauce, oyster sauce.
 *
 * Labels are sparse (`types.ts`'s note, `classifiers/README.md`): a label
 * row is written only when it says something the dimension's default does
 * not. `allergenLabel`/`dietLabel` below throw when a slug has no label, on
 * purpose — most tests assert a specific verdict and an absent label is a
 * bug in the fixture, not a pass. Tests that want to assert absence itself
 * check `labels` directly instead of going through those helpers.
 */

function line(partial: Partial<ClassifierLine> & { ordinal: number; text: string }): ClassifierLine {
  return {
    name: partial.text,
    quantity: null,
    unit: null,
    foodSlug: null,
    via: "miss",
    traits: null,
    ...partial,
  };
}

function resolved(ordinal: number, text: string, foodSlug: string, traits: ClassifierLine["traits"]): ClassifierLine {
  return line({ ordinal, text, foodSlug, via: "exact", traits });
}

function recipe(recipeName: string, lines: ClassifierLine[]): ClassifierInput {
  return { recipeName, lines };
}

function allergenLabel(labels: Label[], slug: string): Label {
  const found = labels.find((l) => l.dimension === "allergen" && l.slug === slug);
  if (!found) throw new Error(`no allergen label for ${slug}`);
  return found;
}

function dietLabel(labels: Label[], slug: string): Label {
  const found = labels.find((l) => l.dimension === "diet" && l.slug === slug);
  if (!found) throw new Error(`no diet label for ${slug}`);
  return found;
}

// A few ordinary, uncontroversial resolved vegetable lines to pad coverage
// without introducing any allergen/diet signal of their own.
const CARROT = resolved(100, "2 carrots, diced", "en:carrot", { vg: TRAIT_YES, vt: TRAIT_YES });
const ONION = resolved(101, "1 onion, sliced", "en:onion", { vg: TRAIT_YES, vt: TRAIT_YES });
const OLIVE_OIL = resolved(102, "2 tbsp olive oil", "en:olive-oil", { vg: TRAIT_YES, vt: TRAIT_YES });

describe("classify — exported surface", () => {
  it("exposes a stable version and the rules method", () => {
    expect(CLASSIFIER_VERSION).toBe(2);
    expect(RULES_METHOD).toBe("rules@1");
  });

  it("stamps every label with the rules method", () => {
    const labels = classify(recipe("Plain roast vegetables", [CARROT, ONION, OLIVE_OIL]));
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) expect(l.method).toBe(RULES_METHOD);
  });
});

/**
 * `classify.ts` and `types.ts` pin the version-vs-emitted-slugs invariant
 * together: absence is only safe to read as a dimension's default for slugs
 * a row's `classifier_version` actually evaluated. This test is that pin —
 * it is not testing behavior so much as fencing it in. If it fails, you
 * (or a PR before you) added or removed a slug from `ALLERGEN_SLUGS` or
 * `EMITTED_DIET_SLUGS` without bumping `CLASSIFIER_VERSION` in
 * `classify.ts`. Bump it, then run a backfill (`POST
 * /jobs/recipe-enrichment` `{"name":"backfill"}`) so every already-classified
 * recipe re-evaluates under the new set — otherwise a recipe classified
 * under the old version silently reports the new default for a slug nothing
 * ever looked at, which for an allergen is exactly the failure this whole
 * feature exists to prevent.
 */
describe("classifier_version — emitted slug sets are pinned to it", () => {
  it("fails if ALLERGEN_SLUGS or EMITTED_DIET_SLUGS change without CLASSIFIER_VERSION changing", () => {
    const snapshot = {
      CLASSIFIER_VERSION,
      allergenSlugs: [...ALLERGEN_SLUGS].sort(),
      dietSlugs: [...EMITTED_DIET_SLUGS].sort(),
    };
    expect(
      snapshot,
      'emitted slug sets changed without a CLASSIFIER_VERSION bump — bump CLASSIFIER_VERSION in classify.ts and run a backfill (POST /jobs/recipe-enrichment {"name":"backfill"}) so every already-classified recipe re-evaluates the new set',
    ).toEqual({
      CLASSIFIER_VERSION: 2,
      allergenSlugs: ["crustacean_shellfish", "egg", "fish", "gluten", "milk", "peanut", "sesame", "soy", "tree_nuts", "wheat"],
      dietSlugs: ["dairy_free", "gluten_free", "halal", "kosher", "pescatarian", "vegan", "vegetarian"],
    });
  });
});

describe("allergen — sparse labels: not_detected is absence, not a row (D5, §3.2, §8.1, sparse-labels follow-up)", () => {
  it("produces no allergen labels at all when every line resolved and none carried any allergen", () => {
    const labels = classify(recipe("Roasted vegetables", [CARROT, ONION, OLIVE_OIL]));
    const allergenLabels = labels.filter((l) => l.dimension === "allergen");
    expect(allergenLabels).toEqual([]);
    // Absence is the point, not merely a filtered-out verdict: confirm no
    // allergen label exists for any slug, not just that the array is empty
    // by coincidence of which slugs happened to be checked.
    for (const slug of ALLERGEN_SLUGS) {
      expect(labels.find((l) => l.dimension === "allergen" && l.slug === slug)).toBeUndefined();
    }
  });

  it("returns unknown, never not_detected, the moment any line fails to resolve", () => {
    const labels = classify(
      recipe("Mystery casserole", [
        CARROT,
        ONION,
        OLIVE_OIL,
        line({ ordinal: 103, text: "1 cup of a secret family spice blend" }), // unresolved, matches no pattern anywhere
      ]),
    );
    for (const slug of ALLERGEN_SLUGS) {
      const verdict = allergenLabel(labels, slug).verdict;
      expect(verdict).not.toBe("not_detected");
      expect(verdict).toBe("unknown" satisfies AllergenVerdict);
    }
  });

  it("returns contains when a resolved food's own traits carry the allergen", () => {
    const labels = classify(recipe("Peanut noodles", [resolved(1, "1/4 cup peanut butter", "en:peanut-butter", { al: ["peanut"] })]));
    const peanut = allergenLabel(labels, "peanut");
    expect(peanut.verdict).toBe("contains" satisfies AllergenVerdict);
    // `contains` should be the highest-confidence verdict this classifier ever emits.
    expect(peanut.confidence).toBeGreaterThanOrEqual(0.9);
  });
});

describe("allergen — text patterns catch what the lexicon misses (§8.1, §8.3)", () => {
  it('flags fish for an unresolved "fish sauce" line, in an otherwise-vegetarian-looking curry', () => {
    const labels = classify(recipe('"Vegetarian" green curry', [CARROT, ONION, line({ ordinal: 3, text: "2 tbsp fish sauce" })]));
    const fish = allergenLabel(labels, "fish");
    expect(fish.verdict).toBe("may_contain" satisfies AllergenVerdict);
    expect(fish.evidence.lines.map((l) => l.ordinal)).toEqual([3]);
    expect(fish.evidence.rule).toBe("text-pattern-unresolved-line");
  });

  it("flags milk for ghee", () => {
    const labels = classify(recipe("Butter chicken", [line({ ordinal: 1, text: "2 tbsp ghee" })]));
    expect(allergenLabel(labels, "milk").verdict).toBe("may_contain" satisfies AllergenVerdict);
  });

  it("flags tree_nuts for marzipan", () => {
    const labels = classify(recipe("Almond cake", [line({ ordinal: 1, text: "200g marzipan" })]));
    expect(allergenLabel(labels, "tree_nuts").verdict).toBe("may_contain" satisfies AllergenVerdict);
  });

  it("flags sesame for tahini", () => {
    const labels = classify(recipe("Hummus", [line({ ordinal: 1, text: "1/4 cup tahini" })]));
    expect(allergenLabel(labels, "sesame").verdict).toBe("may_contain" satisfies AllergenVerdict);
  });

  it("flags fish and gluten for Worcestershire sauce, but not wheat (malt vinegar is barley, not wheat)", () => {
    const labels = classify(recipe("Shepherd's pie", [line({ ordinal: 1, text: "1 tbsp Worcestershire sauce" })]));
    expect(allergenLabel(labels, "fish").verdict).toBe("may_contain" satisfies AllergenVerdict);
    expect(allergenLabel(labels, "gluten").verdict).toBe("may_contain" satisfies AllergenVerdict);
    // The generic "sauce" carrier pattern must defer to the specific
    // "worcestershire" match on the same line — see allergen.ts's module doc.
    expect(allergenLabel(labels, "wheat").verdict).not.toBe("may_contain" satisfies AllergenVerdict);
  });

  it("flags wheat, gluten and soy for soy sauce", () => {
    const labels = classify(recipe("Stir fry", [line({ ordinal: 1, text: "2 tbsp soy sauce" })]));
    expect(allergenLabel(labels, "soy").verdict).toBe("may_contain" satisfies AllergenVerdict);
    expect(allergenLabel(labels, "wheat").verdict).toBe("may_contain" satisfies AllergenVerdict);
    expect(allergenLabel(labels, "gluten").verdict).toBe("may_contain" satisfies AllergenVerdict);
  });

  it("flags wheat and gluten for oyster sauce, but never crustacean_shellfish (oysters are a mollusc, not an FDA crustacean)", () => {
    const labels = classify(recipe("Beef and broccoli", [line({ ordinal: 1, text: "1 tbsp oyster sauce" })]));
    expect(allergenLabel(labels, "wheat").verdict).toBe("may_contain" satisfies AllergenVerdict);
    expect(allergenLabel(labels, "gluten").verdict).toBe("may_contain" satisfies AllergenVerdict);
    const shellfish = allergenLabel(labels, "crustacean_shellfish");
    expect(shellfish.verdict).not.toBe("may_contain" satisfies AllergenVerdict);
    expect(shellfish.verdict).not.toBe("contains" satisfies AllergenVerdict);
  });

  it("does not flag tree_nuts for nutmeg or coconut (word-boundary correctness)", () => {
    const labels = classify(recipe("Spiced pumpkin bread", [line({ ordinal: 1, text: "1/2 tsp ground nutmeg" }), line({ ordinal: 2, text: "1 cup coconut milk" })]));
    expect(allergenLabel(labels, "tree_nuts").verdict).not.toBe("may_contain" satisfies AllergenVerdict);
    expect(allergenLabel(labels, "tree_nuts").verdict).not.toBe("contains" satisfies AllergenVerdict);
  });
});

describe("diet — vegetarian/vegan/pescatarian lean on vg/vt and tg (§8.2)", () => {
  it("excludes vegetarian and vegan for gelatin in a dessert", () => {
    const labels = classify(
      recipe("Panna cotta", [
        resolved(1, "2 cups heavy cream", "en:cream", { vg: TRAIT_NO, vt: TRAIT_YES, al: ["milk"] }),
        resolved(2, "1 packet gelatin", "en:gelatin", { vg: TRAIT_NO, vt: TRAIT_NO }),
      ]),
    );
    expect(dietLabel(labels, "vegetarian").verdict).toBe("excluded" satisfies DietVerdict);
    expect(dietLabel(labels, "vegan").verdict).toBe("excluded" satisfies DietVerdict);
    expect(dietLabel(labels, "vegetarian").evidence.lines.some((l) => l.ordinal === 2)).toBe(true);
  });

  it("excludes vegetarian, vegan, pescatarian, halal and kosher for lard", () => {
    const labels = classify(recipe("Pie crust", [resolved(1, "1 cup lard", "en:lard", { vg: TRAIT_NO, vt: TRAIT_NO, tg: ["pork"] })]));
    expect(dietLabel(labels, "vegetarian").verdict).toBe("excluded" satisfies DietVerdict);
    expect(dietLabel(labels, "vegan").verdict).toBe("excluded" satisfies DietVerdict);
    expect(dietLabel(labels, "pescatarian").verdict).toBe("excluded" satisfies DietVerdict);
    expect(dietLabel(labels, "halal").verdict).toBe("excluded" satisfies DietVerdict);
    expect(dietLabel(labels, "kosher").verdict).toBe("excluded" satisfies DietVerdict);
  });

  it("keeps pescatarian likely when only seafood (not land meat) is present", () => {
    const labels = classify(recipe("Grilled salmon", [resolved(1, "1 salmon fillet", "en:salmon", { vg: TRAIT_NO, vt: TRAIT_NO, tg: ["seafood"], al: ["fish"] }), OLIVE_OIL]));
    expect(dietLabel(labels, "vegetarian").verdict).toBe("excluded" satisfies DietVerdict);
    expect(dietLabel(labels, "pescatarian").verdict).toBe("likely" satisfies DietVerdict);
  });

  it("marks vegetarian/vegan unknown, not likely, when the vt/vg trait is itself ambiguous", () => {
    const labels = classify(recipe("Mystery broth base", [resolved(1, "1 cube stock concentrate", "en:stock-concentrate", { vt: TRAIT_MAYBE, vg: TRAIT_MAYBE })]));
    expect(dietLabel(labels, "vegetarian").verdict).toBe("unknown" satisfies DietVerdict);
    expect(dietLabel(labels, "vegan").verdict).toBe("unknown" satisfies DietVerdict);
  });
});

describe("diet — unresolved-line animal-origin pass (fix for d-d9cf5451)", () => {
  it('excludes vegetarian and vegan for an unresolved "fish sauce" line, but leaves pescatarian likely', () => {
    // foodSlug: null, via: "miss" — the lexicon cannot rescue this line.
    const labels = classify(recipe('"Vegetarian" green curry', [CARROT, ONION, OLIVE_OIL, line({ ordinal: 4, text: "2 tbsp fish sauce" })]));
    expect(dietLabel(labels, "vegetarian").verdict).toBe("excluded" satisfies DietVerdict);
    expect(dietLabel(labels, "vegan").verdict).toBe("excluded" satisfies DietVerdict);
    expect(dietLabel(labels, "vegetarian").evidence.rule).toBe("unresolved-animal-text-pattern");
    expect(dietLabel(labels, "vegetarian").evidence.lines.map((l) => l.ordinal)).toEqual([4]);
    // Fish is fine for pescatarian — only land meat excludes it.
    expect(dietLabel(labels, "pescatarian").verdict).toBe("likely" satisfies DietVerdict);
  });

  it('excludes vegetarian, vegan and pescatarian for an unresolved "lard" line', () => {
    const labels = classify(recipe("Pie crust", [line({ ordinal: 1, text: "1 cup lard" })]));
    expect(dietLabel(labels, "vegetarian").verdict).toBe("excluded" satisfies DietVerdict);
    expect(dietLabel(labels, "vegan").verdict).toBe("excluded" satisfies DietVerdict);
    expect(dietLabel(labels, "pescatarian").verdict).toBe("excluded" satisfies DietVerdict);
  });

  it.each(["nam pla", "bonito flakes", "shrimp paste", "lardons"])('never returns likely vegetarian for an unresolved "%s" line', (text) => {
    const labels = classify(recipe("Mystery dish", [CARROT, ONION, OLIVE_OIL, line({ ordinal: 4, text: `1 tbsp ${text}` })]));
    expect(dietLabel(labels, "vegetarian").verdict).not.toBe("likely" satisfies DietVerdict);
  });

  it('marks vegetarian unknown, never likely, for an unresolved generic "stock" line', () => {
    const labels = classify(recipe("Soup base", [CARROT, ONION, OLIVE_OIL, line({ ordinal: 4, text: "2 cups stock" })]));
    const vegetarian = dietLabel(labels, "vegetarian");
    expect(vegetarian.verdict).toBe("unknown" satisfies DietVerdict);
    expect(vegetarian.verdict).not.toBe("likely" satisfies DietVerdict);
  });

  it("is still likely vegetarian for a fully-resolved, genuinely plant-based recipe", () => {
    const labels = classify(recipe("Roasted vegetables", [CARROT, ONION, OLIVE_OIL]));
    expect(dietLabel(labels, "vegetarian").verdict).toBe("likely" satisfies DietVerdict);
    expect(dietLabel(labels, "vegan").verdict).toBe("likely" satisfies DietVerdict);
  });
});

describe("diet — dairy_free / gluten_free fall out of the allergen facts (§8.2)", () => {
  it("excludes dairy_free when a resolved line's traits carry milk", () => {
    const labels = classify(recipe("Mac and cheese", [resolved(1, "1 cup cheddar", "en:cheddar", { al: ["milk"] }), CARROT]));
    expect(dietLabel(labels, "dairy_free").verdict).toBe("excluded" satisfies DietVerdict);
  });

  it("excludes gluten_free when a resolved line's traits carry wheat or gluten", () => {
    const labels = classify(recipe("Sandwich bread", [resolved(1, "2 cups flour", "en:wheat-flour", { al: ["wheat", "gluten"] }), OLIVE_OIL]));
    expect(dietLabel(labels, "gluten_free").verdict).toBe("excluded" satisfies DietVerdict);
  });

  it("is likely dairy_free and gluten_free for a plain resolved vegetable recipe", () => {
    const labels = classify(recipe("Roasted vegetables", [CARROT, ONION, OLIVE_OIL]));
    expect(dietLabel(labels, "dairy_free").verdict).toBe("likely" satisfies DietVerdict);
    expect(dietLabel(labels, "gluten_free").verdict).toBe("likely" satisfies DietVerdict);
  });
});

describe("diet — halal and kosher: excluded, or no label at all (D6, §8.2, sparse-labels follow-up)", () => {
  it("produces no halal or kosher label for a plain harmless recipe — never likely, and no longer unknown either", () => {
    const labels = classify(recipe("Roasted vegetables", [CARROT, ONION, OLIVE_OIL]));
    expect(labels.find((l) => l.dimension === "diet" && l.slug === "halal")).toBeUndefined();
    expect(labels.find((l) => l.dimension === "diet" && l.slug === "kosher")).toBeUndefined();
  });

  it("excludes halal and kosher for alcohol, and never returns likely for either regardless of input", () => {
    const labels = classify(recipe("Coq au vin", [resolved(1, "1 cup red wine", "en:red-wine", { tg: ["alcohol"] }), CARROT]));
    expect(dietLabel(labels, "halal").verdict).toBe("excluded" satisfies DietVerdict);
    expect(dietLabel(labels, "kosher").verdict).toBe("excluded" satisfies DietVerdict);
  });

  it("excludes kosher for meat/dairy co-occurrence even without pork, alcohol or shellfish", () => {
    const labels = classify(recipe("Cheeseburger", [resolved(1, "1 beef patty", "en:beef", { tg: ["meat"] }), resolved(2, "1 slice cheddar", "en:cheddar", { al: ["milk"] })]));
    expect(dietLabel(labels, "kosher").verdict).toBe("excluded" satisfies DietVerdict);
    expect(dietLabel(labels, "kosher").evidence.rule).toBe("meat-and-dairy-cooccurrence");
    // Halal has no meat/dairy rule — the same recipe should get no halal
    // label at all, not an excluded or unknown one, on that basis.
    expect(labels.find((l) => l.dimension === "diet" && l.slug === "halal")).toBeUndefined();
  });
});

describe("diet — deleted slugs produce nothing (§8.2, §13, sparse-labels follow-up)", () => {
  it.each(["keto", "low_carb", "low_fat", "low_calorie", "diabetic", "paleo"])("%s has no rule any more and produces no label, on any recipe", (slug) => {
    const labels = classify(recipe("Anything", [CARROT, ONION, OLIVE_OIL]));
    expect(labels.find((l) => l.dimension === "diet" && l.slug === slug)).toBeUndefined();
  });

  it("a recipe with allergen and diet signal still produces no label for any deleted slug", () => {
    // A busier fixture than the plain-vegetables one above, to confirm the
    // deleted slugs stay gone even once the classifier has plenty else to say.
    const labels = classify(
      recipe("Peanut noodles with pork", [
        resolved(1, "1/4 cup peanut butter", "en:peanut-butter", { al: ["peanut"] }),
        resolved(2, "1 cup lard", "en:lard", { vg: TRAIT_NO, vt: TRAIT_NO, tg: ["pork"] }),
      ]),
    );
    for (const slug of ["keto", "low_carb", "low_fat", "low_calorie", "diabetic", "paleo"]) {
      expect(labels.find((l) => l.dimension === "diet" && l.slug === slug)).toBeUndefined();
    }
  });
});

describe("determinism", () => {
  it("returns the same labels for the same input", () => {
    const input = recipe('"Vegetarian" green curry', [CARROT, ONION, line({ ordinal: 3, text: "2 tbsp fish sauce" })]);
    expect(classify(input)).toEqual(classify(input));
  });
});
