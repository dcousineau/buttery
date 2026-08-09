import { describe, expect, it } from "vitest";
import { DIET_MAPPINGS, dietSlugFromToken, dietToken, dietTokenFromSchemaOrg, dietTokensFromSchemaOrg, dietUrlForSlug, dietUrlsForSlugs } from "./vocab.ts";
import { RESTRICTED_DIET_MEMBERS } from "../schema-org/vocab.ts";

/**
 * The diet crosswalk used to exist twice, in opposite directions and out of
 * sync. These tests are the reason it can't happen again.
 */

// Verbatim from the `recipe_vocab` diet seed in migration
// 1785300000000_create_recipe_rendered.ts, mirrored by the web app's
// recipe-vocab.ts. If that seed changes, this list — and the table — must too.
const SEEDED_DIET_SUFFIXES = ["Diabetic", "GlutenFree", "Halal", "Keto", "Kosher", "LowCalorie", "LowCarb", "LowFat", "Paleo", "Vegan", "Vegetarian"];

describe("diet crosswalk", () => {
  it("covers exactly the seeded vocab — no more, no less", () => {
    expect(DIET_MAPPINGS.map((d) => d.suffix).sort()).toEqual([...SEEDED_DIET_SUFFIXES].sort());
  });

  it("only names real RestrictedDiet members", () => {
    for (const mapping of DIET_MAPPINGS) {
      if (mapping.schemaOrg) expect(RESTRICTED_DIET_MEMBERS).toContain(mapping.schemaOrg);
    }
  });

  it("round-trips slug → schema.org → lexicon token → slug", () => {
    for (const mapping of DIET_MAPPINGS) {
      const url = dietUrlForSlug(mapping.slug);
      if (!mapping.schemaOrg) {
        expect(url).toBeNull(); // Keto/LowCarb/Paleo: schema.org can't express them
        continue;
      }
      expect(url).toBe(`https://schema.org/${mapping.schemaOrg}`);
      const token = dietTokenFromSchemaOrg(url);
      expect(token).toBe(dietToken(mapping));
      expect(dietSlugFromToken(token)).toBe(mapping.slug);
    }
  });

  it("accepts the diet forms pages actually emit", () => {
    const expected = "exchange.recipe.defs#dietVegan";
    expect(dietTokenFromSchemaOrg("https://schema.org/VeganDiet")).toBe(expected);
    expect(dietTokenFromSchemaOrg("http://schema.org/VeganDiet")).toBe(expected);
    expect(dietTokenFromSchemaOrg("https://schema.org/VeganDiet/")).toBe(expected);
    expect(dietTokenFromSchemaOrg("  vegandiet ")).toBe(expected);
  });

  it("drops diets we can't map, in both directions", () => {
    // Real RestrictedDiet members that aren't in our vocab. The recipe page used
    // to carry these three as unreachable entries in its own map.
    expect(dietTokenFromSchemaOrg("https://schema.org/HinduDiet")).toBeNull();
    expect(dietTokenFromSchemaOrg("https://schema.org/LowLactoseDiet")).toBeNull();
    expect(dietTokenFromSchemaOrg("https://schema.org/LowSaltDiet")).toBeNull();
    expect(dietTokenFromSchemaOrg("https://schema.org/NotADiet")).toBeNull();
    // Ours that schema.org has no member for.
    expect(dietUrlForSlug("keto")).toBeNull();
    expect(dietUrlForSlug("nonsense")).toBeNull();
  });

  it("dedupes lists in both directions", () => {
    expect(dietTokensFromSchemaOrg(["https://schema.org/VeganDiet", "VeganDiet", "https://schema.org/KetoDiet"])).toEqual(["exchange.recipe.defs#dietVegan"]);
    expect(dietUrlsForSlugs(["vegan", "vegan", "keto"])).toEqual(["https://schema.org/VeganDiet"]);
    expect(dietUrlsForSlugs(undefined)).toEqual([]);
  });
});
