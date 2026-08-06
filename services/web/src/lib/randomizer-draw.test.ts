import { describe, expect, it } from "vitest";
import { buildShareText, drawRandom } from "./randomizer-draw";

/**
 * Meal randomizer draw logic (plan §5, §8). Pure unit tests — no DB, no
 * component rendering. `rng` is injected wherever the outcome index matters so
 * results are deterministic.
 */

interface Card {
  recipeId: string;
  title: string;
}

const one: Card[] = [{ recipeId: "a", title: "Soup" }];
const two: Card[] = [
  { recipeId: "a", title: "Soup" },
  { recipeId: "b", title: "Salad" },
];
const many: Card[] = [
  { recipeId: "a", title: "Soup" },
  { recipeId: "b", title: "Salad" },
  { recipeId: "c", title: "Stew" },
  { recipeId: "d", title: "Roast" },
  { recipeId: "e", title: "Bake" },
];

describe("drawRandom — empty pool", () => {
  it("returns null", () => {
    expect(drawRandom([], null)).toBeNull();
    expect(drawRandom([], "a")).toBeNull();
  });
});

describe("drawRandom — uniform draw", () => {
  it("draws the only item from a pool of 1", () => {
    expect(drawRandom(one, null, () => 0)).toEqual(one[0]);
    expect(drawRandom(one, null, () => 0.999)).toEqual(one[0]);
  });

  it("draws by rng position from a pool of 2", () => {
    expect(drawRandom(two, null, () => 0)).toEqual(two[0]);
    expect(drawRandom(two, null, () => 0.99)).toEqual(two[1]);
  });

  it("draws by rng position from a pool of N", () => {
    expect(drawRandom(many, null, () => 0)).toEqual(many[0]);
    expect(drawRandom(many, null, () => 0.41)).toEqual(many[2]); // floor(0.41*5) = 2
    expect(drawRandom(many, null, () => 0.99)).toEqual(many[4]);
  });

  it("clamps an out-of-spec rng() === 1 to the last candidate", () => {
    expect(drawRandom(many, null, () => 1)).toEqual(many[4]);
  });
});

describe("drawRandom — no-repeat exclusion (pool size 1)", () => {
  it("draws the excluded id again — nothing else to offer", () => {
    expect(drawRandom(one, "a", () => 0)).toEqual(one[0]);
  });
});

describe("drawRandom — no-repeat exclusion (pool size 2)", () => {
  it("excludes the last id, leaving exactly one candidate", () => {
    // Candidates after excluding "a" is just [b], so any rng() draws it.
    expect(drawRandom(two, "a", () => 0)).toEqual(two[1]);
    expect(drawRandom(two, "a", () => 0.99)).toEqual(two[1]);
  });

  it("excludes the other id symmetrically", () => {
    expect(drawRandom(two, "b", () => 0)).toEqual(two[0]);
  });
});

describe("drawRandom — no-repeat exclusion (pool size N)", () => {
  it("excludes the last id from the candidate set", () => {
    // Excluding "c" leaves [a, b, d, e]; rng 0.99 -> floor(0.99*4)=3 -> "e".
    expect(drawRandom(many, "c", () => 0.99)).toEqual(many[4]);
    // rng 0 -> index 0 -> "a" (first remaining candidate).
    expect(drawRandom(many, "c", () => 0)).toEqual(many[0]);
  });

  it("never draws the excluded id across the full candidate range", () => {
    for (let i = 0; i < many.length; i++) {
      const rng = () => i / many.length;
      const drawn = drawRandom(many, "b", rng);
      expect(drawn?.recipeId).not.toBe("b");
    }
  });
});

describe("buildShareText", () => {
  it("formats name + blank line + ingredient list with no optional fields", () => {
    const text = buildShareText({ title: "Tomato Soup", ingredients: ["2 cups tomatoes", "1 onion"] });
    expect(text).toBe("Tomato Soup\n\n- 2 cups tomatoes\n- 1 onion");
  });

  it("appends total time when present", () => {
    const text = buildShareText({ title: "Tomato Soup", ingredients: ["2 cups tomatoes"], totalTimeDisplay: "30m" });
    expect(text).toBe("Tomato Soup\n\n- 2 cups tomatoes\n\nTotal time: 30m");
  });

  it("appends source URL when present", () => {
    const text = buildShareText({ title: "Tomato Soup", ingredients: ["2 cups tomatoes"], sourceUrl: "https://example.com/soup" });
    expect(text).toBe("Tomato Soup\n\n- 2 cups tomatoes\n\nhttps://example.com/soup");
  });

  it("appends both total time and source URL, time first", () => {
    const text = buildShareText({
      title: "Tomato Soup",
      ingredients: ["2 cups tomatoes"],
      totalTimeDisplay: "30m",
      sourceUrl: "https://example.com/soup",
    });
    expect(text).toBe("Tomato Soup\n\n- 2 cups tomatoes\n\nTotal time: 30m\nhttps://example.com/soup");
  });

  it("handles an empty ingredient list", () => {
    const text = buildShareText({ title: "Mystery Dish", ingredients: [] });
    expect(text).toBe("Mystery Dish\n");
  });
});
