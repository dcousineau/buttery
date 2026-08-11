import { describe, expect, it } from "vitest";
import { recipeOgFingerprint, recipeOgModel, recipeOgVersion, renderRecipeOgPng } from "./recipe-og";
import type { RecipeDetailData } from "#/server/recipes";

/**
 * The OG image's model projection (the part with all the product decisions in
 * it) plus one end-to-end raster to prove the Satori → resvg pipeline and the
 * vendored fonts actually produce a PNG.
 *
 * The render test runs here rather than as a standalone script because the font
 * module imports `.ttf?inline`, which only Vite resolves — and vitest runs
 * through Vite.
 */

function recipe(overrides: Partial<RecipeDetailData> = {}): RecipeDetailData {
  return {
    id: "3lb2xyz",
    name: "Brown butter chocolate chip cookies",
    description: "Nutty, chewy, and worth the extra pan you have to wash.",
    publishedAt: "2026-01-02T03:04:05.000Z",
    imageUrl: null,
    imageAlt: null,
    publishedBy: "@deb.bsky.social",
    publisherUrl: null,
    app: null,
    appUrl: null,
    uri: null,
    did: "did:plc:example",
    images: [],
    ingredients: [],
    instructions: [],
    keywords: [],
    recipeYield: null,
    prepTime: null,
    cookTime: null,
    totalTime: null,
    cuisine: null,
    category: null,
    cookingMethod: null,
    suitableForDiet: [],
    calories: null,
    attribution: null,
    ...overrides,
  };
}

describe("recipeOgModel — source line", () => {
  it("credits a book with its author after an em dash", () => {
    const model = recipeOgModel(
      recipe({
        attribution: { kind: "publication", displayName: "Bittman's Kitchen Express", author: "Mark Bittman", publisher: "Clarkson Potter", url: null },
      }),
    );
    expect(model.sourceKicker).toBe("FROM A BOOK");
    expect(model.sourceLabel).toBe("Bittman's Kitchen Express — Mark Bittman");
  });

  it("uses a website's display name when it reads like a name", () => {
    const model = recipeOgModel(
      recipe({ attribution: { kind: "website", displayName: "Smitten Kitchen", author: null, publisher: null, url: "https://smittenkitchen.com/2020/cookies/" } }),
    );
    expect(model.sourceKicker).toBe("FROM");
    expect(model.sourceLabel).toBe("Smitten Kitchen");
  });

  it("falls back to the bare hostname when the display name is just the domain", () => {
    const model = recipeOgModel(
      recipe({ attribution: { kind: "website", displayName: "www.smittenkitchen.com", author: null, publisher: null, url: "https://www.smittenkitchen.com/x" } }),
    );
    expect(model.sourceLabel).toBe("smittenkitchen.com");
  });

  it("names a person", () => {
    const model = recipeOgModel(recipe({ attribution: { kind: "person", displayName: "Deb Perelman", author: null, publisher: null, url: null } }));
    expect(model.sourceKicker).toBe("BY");
    expect(model.sourceLabel).toBe("Deb Perelman");
  });

  it("credits an original to the publishing account", () => {
    const model = recipeOgModel(recipe({ attribution: { kind: "original", displayName: null, author: null, publisher: null, url: "https://example.com" } }));
    expect(model.sourceKicker).toBe("AN ORIGINAL BY");
    expect(model.sourceLabel).toBe("@deb.bsky.social");
  });

  it("falls back to the publisher handle with no attribution at all", () => {
    const model = recipeOgModel(recipe());
    expect(model.sourceKicker).toBe("SHARED BY");
    expect(model.sourceLabel).toBe("@deb.bsky.social");
  });

  it("leaves both null when there is nothing to credit", () => {
    const model = recipeOgModel(recipe({ publishedBy: null }));
    expect(model.sourceKicker).toBeNull();
    expect(model.sourceLabel).toBeNull();
  });
});

describe("recipeOgModel — facts and fields", () => {
  it("builds chips in priority order and caps at four", () => {
    const model = recipeOgModel(
      recipe({
        totalTime: "PT45M",
        prepTime: "PT10M",
        recipeYield: "4",
        ingredients: ["a", "b", "c"],
        cuisine: "Italian",
        suitableForDiet: ["Vegetarian"],
        calories: 320,
      }),
    );
    expect(model.facts).toEqual(["45m", "Serves 4", "3 ingredients", "Italian"]);
  });

  it("keeps a non-numeric yield as written, singularises one ingredient, and skips empties", () => {
    const model = recipeOgModel(recipe({ cookTime: "PT1H30M", recipeYield: "two loaves", ingredients: ["flour"], description: "   " }));
    expect(model.facts).toEqual(["1h 30m", "Two loaves", "1 ingredient"]);
    expect(model.description).toBeNull();
  });

  it("takes the hero from the first image, and null when there are none", () => {
    expect(recipeOgModel(recipe()).heroUrl).toBeNull();
    const withImage = recipeOgModel(recipe({ images: [{ url: "https://cdn.example/a.jpg", alt: null, aspectW: null, aspectH: null }] }));
    expect(withImage.heroUrl).toBe("https://cdn.example/a.jpg");
  });
});

describe("recipeOgFingerprint", () => {
  it("is a stable 16-char hex digest", () => {
    const model = recipeOgModel(recipe());
    expect(recipeOgFingerprint(model)).toMatch(/^[0-9a-f]{16}$/);
    expect(recipeOgFingerprint(model)).toBe(recipeOgFingerprint(recipeOgModel(recipe())));
  });

  it("changes when anything visible changes", () => {
    const before = recipeOgFingerprint(recipeOgModel(recipe()));
    expect(recipeOgFingerprint(recipeOgModel(recipe({ name: "Something else" })))).not.toBe(before);
    expect(recipeOgFingerprint(recipeOgModel(recipe({ totalTime: "PT20M" })))).not.toBe(before);
  });
});

describe("recipeOgVersion", () => {
  it("is a stable 8-char hex token", () => {
    const model = recipeOgModel(recipe());
    expect(recipeOgVersion(model)).toMatch(/^[0-9a-f]{8}$/);
    expect(recipeOgVersion(model)).toBe(recipeOgVersion(recipeOgModel(recipe())));
  });

  // The whole immutable-caching scheme rests on this: if an edit that changes
  // the picture can leave the token alone, a CDN happily serves the old card for
  // a year. Same reason the fingerprint hashes the whole model.
  it("changes when anything visible changes", () => {
    const before = recipeOgVersion(recipeOgModel(recipe()));
    expect(recipeOgVersion(recipeOgModel(recipe({ name: "Something else" })))).not.toBe(before);
    expect(recipeOgVersion(recipeOgModel(recipe({ description: "Rewritten." })))).not.toBe(before);
    expect(recipeOgVersion(recipeOgModel(recipe({ images: [{ url: "https://cdn.example/other.jpg", alt: null, aspectW: null, aspectH: null }] })))).not.toBe(before);
  });
});

describe("renderRecipeOgPng", () => {
  it("rasterises a text-only card", { timeout: 30_000 }, async () => {
    const model = recipeOgModel(
      recipe({
        totalTime: "PT45M",
        recipeYield: "4",
        ingredients: ["butter", "sugar", "flour"],
        cuisine: "American",
        attribution: { kind: "publication", displayName: "Bittman's Kitchen Express", author: "Mark Bittman", publisher: null, url: null },
      }),
    );
    expect(model.heroUrl).toBeNull();

    const png = await renderRecipeOgPng(model);
    // PNG magic bytes: \x89 P N G \r \n \x1a \n
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.byteLength).toBeGreaterThan(5_000);
  });
});
