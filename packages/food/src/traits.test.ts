import { describe, expect, it } from "vitest";
import traitsJson from "./traits.json" with { type: "json" };
import { type TraitsFile, traitsFor } from "./traits";

/**
 * Runs over the real generated `traits.json`, not a hand-built fixture — the
 * point of these assertions is that §8's classifiers can rely on them, and
 * that is only true if they hold against the actual pinned taxonomy. Every id
 * below was looked up in the generated file first (see the plan §4.1
 * implementer's report); none are hoped-for ids.
 */
const traits = traitsJson as unknown as TraitsFile;

describe("traitsFor", () => {
  it("returns {} for a food the file has no traits for", () => {
    expect(traitsFor(traits, "en:does-not-exist")).toEqual({});
  });

  it("returns the stored traits for a known food", () => {
    expect(traitsFor(traits, "en:mozzarella")).toEqual({ vg: 0, vt: 2, al: ["milk"] });
  });
});

describe("dairy carries the milk allergen", () => {
  it("en:mozzarella is not vegan (0) and carries milk", () => {
    const t = traitsFor(traits, "en:mozzarella");
    expect(t.vg).toBe(0);
    expect(t.al).toContain("milk");
  });
});

describe("diet properties inherit down with nearest-ancestor semantics", () => {
  it("en:chicken-breast inherits vt: 0 (not vegetarian) from an ancestor under en:meat", () => {
    const t = traitsFor(traits, "en:chicken-breast");
    expect(t.vg).toBe(0);
    expect(t.vt).toBe(0);
  });
});

describe("tags accumulate over the whole ancestor closure", () => {
  it("en:pork-shoulder is not en:pork itself but still carries the pork tag through inheritance", () => {
    const t = traitsFor(traits, "en:pork-shoulder");
    expect(t.tg).toEqual(expect.arrayContaining(["meat", "pork"]));
  });
});

describe("allergens accumulate over the whole ancestor closure", () => {
  it("en:soy-and-sesame-sauce carries allergens contributed by more than one ancestor branch", () => {
    // Inherits sesame from one parent and soy/wheat/gluten from another —
    // the multi-allergen case plan §4.1 names (its own example is
    // `en:pesto`, which this taxonomy revision does not place under a dairy
    // or tree-nut ancestor; this is the real node that demonstrates the
    // same fold).
    const t = traitsFor(traits, "en:soy-and-sesame-sauce");
    expect(t.al).toEqual(expect.arrayContaining(["sesame", "soy", "wheat", "gluten"]));
    expect(t.al!.length).toBeGreaterThan(1);
  });
});

describe("generated file shape", () => {
  it("carries provenance metadata matching lexicon.json's", () => {
    expect(traits.__meta.source).toBe("Open Food Facts");
    expect(traits.__meta.license).toBe("ODbL-1.0");
    expect(typeof traits.__meta.sourceCommit).toBe("string");
  });

  it("every trait entry carries at least one of vg/vt/al/tg", () => {
    for (const [id, food] of Object.entries(traits.foods)) {
      const hasSomething = food.vg !== undefined || food.vt !== undefined || (food.al?.length ?? 0) > 0 || (food.tg?.length ?? 0) > 0;
      expect(hasSomething, `${id} carries no trait but has an entry`).toBe(true);
    }
  });
});
