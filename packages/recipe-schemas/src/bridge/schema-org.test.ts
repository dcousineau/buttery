import { describe, expect, it } from "vitest";
import { lexiconToSchemaOrg, schemaOrgToLexicon } from "./schema-org.ts";
import { schemaOrgRecipeSchema } from "../schema-org/zod.ts";

const BASE = "https://example.com/recipes/cookies";

describe("schemaOrgToLexicon", () => {
  it("maps a full node, resolving diets and parsing nutrition", () => {
    const recipe = schemaOrgToLexicon(
      {
        "@type": "Recipe",
        name: "Brown Butter Cookies",
        description: "Chewy, nutty, best kept.",
        recipeIngredient: ["2 cups flour"],
        recipeInstructions: [{ "@type": "HowToStep", text: "Brown the butter." }],
        cookTime: "12 minutes",
        recipeYield: 24,
        keywords: "cookies, dessert",
        image: "/hero.jpg",
        suitableForDiet: ["https://schema.org/VegetarianDiet", "https://schema.org/KetoDiet"],
        recipeCuisine: "American",
        nutrition: { calories: "210 calories", fatContent: "11 g" },
      },
      BASE,
    );

    expect(recipe).toEqual({
      name: "Brown Butter Cookies",
      text: "Chewy, nutty, best kept.",
      ingredients: ["2 cups flour"],
      instructions: ["Brown the butter."],
      cookTime: "PT12M",
      recipeYield: "24",
      keywords: ["cookies", "dessert"],
      imageUrl: "https://example.com/hero.jpg",
      // Keto has no schema.org member → dropped; Vegetarian resolves to a token.
      suitableForDiet: ["exchange.recipe.defs#dietVegetarian"],
      vocab: { cuisine: "American", category: undefined, method: undefined },
      nutrition: { calories: 210, fatContent: "11" },
    });
  });

  it("omits absent fields rather than setting them undefined", () => {
    // The extractor merges sources by backfilling absent keys, so a present key
    // holding `undefined` would wrongly claim the field.
    const recipe = schemaOrgToLexicon({ "@type": "Recipe", name: "Bare" }, BASE);
    expect(Object.keys(recipe)).toEqual(["name"]);
  });
});

describe("lexiconToSchemaOrg", () => {
  it("emits a document that validates against the canonical schema", () => {
    const doc = lexiconToSchemaOrg({
      name: "Brown Butter Cookies",
      description: "Chewy, nutty, best kept.",
      imageUrls: ["https://example.com/hero.jpg"],
      author: { name: "Some Blog", kind: "publication", url: "https://blog.example" },
      datePublished: "2026-08-09T00:00:00Z",
      cookTime: "PT12M",
      recipeYield: "24 cookies",
      cuisine: "American",
      dietSlugs: ["vegetarian", "keto"],
      keywords: ["cookies", "dessert"],
      ingredients: ["2 cups flour"],
      instructions: ["Brown the butter."],
      calories: 210,
      url: "at://did:plc:example/exchange.recipe.recipe/abc",
    });

    expect(schemaOrgRecipeSchema.safeParse(doc).success).toBe(true);
    expect(doc.keywords).toBe("cookies, dessert"); // one comma-separated string
    expect(doc.recipeInstructions).toEqual([{ "@type": "HowToStep", text: "Brown the butter." }]);
    expect(doc.nutrition).toEqual({ "@type": "NutritionInformation", calories: "210 calories" });
    // Keto can't be expressed in RestrictedDiet, so it doesn't appear.
    expect(doc.suitableForDiet).toEqual(["https://schema.org/VegetarianDiet"]);
  });

  it("types a non-person attribution as an Organization", () => {
    expect(lexiconToSchemaOrg({ name: "X", author: { name: "Ada", kind: "person" } }).author).toEqual({ "@type": "Person", name: "Ada" });
    expect(lexiconToSchemaOrg({ name: "X", author: { name: "Bon Appétit", kind: "publication" } }).author).toEqual({ "@type": "Organization", name: "Bon Appétit" });
  });

  it("emits only the fields it has — never null", () => {
    const doc = lexiconToSchemaOrg({ name: "Bare", description: null, cookTime: null, calories: null, dietSlugs: [], keywords: [] });
    expect(Object.keys(doc)).toEqual(["@context", "@type", "name"]);
    expect(schemaOrgRecipeSchema.safeParse(doc).success).toBe(true);
  });

  it("round-trips through the read side", () => {
    const doc = lexiconToSchemaOrg({
      name: "Round Trip",
      ingredients: ["salt"],
      instructions: ["Stir."],
      cookTime: "PT12M",
      dietSlugs: ["vegan"],
      keywords: ["easy"],
    });
    const back = schemaOrgToLexicon({ ...doc }, BASE);
    expect(back.name).toBe("Round Trip");
    expect(back.ingredients).toEqual(["salt"]);
    expect(back.instructions).toEqual(["Stir."]);
    expect(back.cookTime).toBe("PT12M");
    expect(back.keywords).toEqual(["easy"]);
    expect(back.suitableForDiet).toEqual(["exchange.recipe.defs#dietVegan"]);
  });
});
