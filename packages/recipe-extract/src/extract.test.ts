import { describe, expect, it } from "vitest";
import { extractRecipe } from "./index.ts";

const URL = "https://example.com/recipes/cookies";

function page(head: string, body = ""): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

describe("extractRecipe — JSON-LD", () => {
  it("pulls a full schema.org/Recipe with @graph, HowToStep, ISO + human times", () => {
    const ld = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "Site" },
        {
          "@type": "Recipe",
          name: "Brown Butter Cookies",
          description: "Chewy, nutty, best kept.",
          recipeIngredient: ["2 cups flour", "1 cup butter", "  "],
          recipeInstructions: [
            { "@type": "HowToStep", text: "Brown the butter." },
            { "@type": "HowToStep", text: "Mix and bake 12 minutes." },
          ],
          prepTime: "PT15M",
          cookTime: "12 minutes",
          totalTime: "PT27M",
          recipeYield: "24 cookies",
          keywords: "cookies, dessert, brown butter",
          image: ["https://example.com/hero.jpg"],
          suitableForDiet: ["https://schema.org/VegetarianDiet", "https://schema.org/KetoDiet"],
          recipeCuisine: "American",
          nutrition: { "@type": "NutritionInformation", calories: "210 calories", fatContent: "11 g" },
        },
      ],
    };
    const r = extractRecipe({ url: URL, html: page(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`) });

    expect(r.ok).toBe(true);
    expect(r.extractor).toBe("jsonld");
    expect(r.recipe.name).toBe("Brown Butter Cookies");
    expect(r.recipe.ingredients).toEqual(["2 cups flour", "1 cup butter"]); // blank dropped
    expect(r.recipe.instructions).toEqual(["Brown the butter.", "Mix and bake 12 minutes."]);
    expect(r.recipe.prepTime).toBe("PT15M");
    expect(r.recipe.cookTime).toBe("PT12M"); // human → ISO
    expect(r.recipe.recipeYield).toBe("24 cookies");
    expect(r.recipe.keywords).toEqual(["cookies", "dessert", "brown butter"]);
    expect(r.recipe.imageUrl).toBe("https://example.com/hero.jpg");
    // Keto has no schema.org member → dropped; Vegetarian mapped to a token.
    expect(r.recipe.suitableForDiet).toEqual(["exchange.recipe.defs#dietVegetarian"]);
    expect(r.recipe.vocab?.cuisine).toBe("American");
    expect(r.recipe.nutrition).toEqual({ calories: 210, fatContent: "11" });
  });

  it("flattens HowToSection into steps", () => {
    const ld = {
      "@type": "Recipe",
      name: "Sectioned",
      recipeIngredient: ["salt"],
      recipeInstructions: [
        {
          "@type": "HowToSection",
          itemListElement: [
            { "@type": "HowToStep", text: "Step one." },
            { "@type": "HowToStep", text: "Step two." },
          ],
        },
      ],
    };
    const r = extractRecipe({ url: URL, html: page(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`) });
    expect(r.recipe.instructions).toEqual(["Step one.", "Step two."]);
  });
});

describe("extractRecipe — microdata fallback", () => {
  it("reads itemprop markup when no JSON-LD is present", () => {
    const body = `
      <div itemscope itemtype="https://schema.org/Recipe">
        <h1 itemprop="name">Microdata Cake</h1>
        <p itemprop="description">A test cake.</p>
        <time itemprop="totalTime" datetime="PT45M">45 min</time>
        <li itemprop="recipeIngredient">1 cup sugar</li>
        <li itemprop="recipeIngredient">2 eggs</li>
        <div itemprop="recipeInstructions">Mix everything.</div>
        <div itemprop="recipeInstructions">Bake it.</div>
      </div>`;
    const r = extractRecipe({ url: URL, html: page("", body) });
    expect(r.ok).toBe(true);
    expect(r.extractor).toBe("microdata");
    expect(r.recipe.name).toBe("Microdata Cake");
    expect(r.recipe.ingredients).toEqual(["1 cup sugar", "2 eggs"]);
    expect(r.recipe.instructions).toEqual(["Mix everything.", "Bake it."]);
    expect(r.recipe.totalTime).toBe("PT45M");
  });
});

describe("extractRecipe — heuristics only", () => {
  it("returns not-ok but seeds title + image from OpenGraph", () => {
    const head = `<meta property="og:title" content="Some Blocked Recipe"><meta property="og:image" content="/img/hero.png">`;
    const r = extractRecipe({ url: URL, html: page(head) });
    expect(r.ok).toBe(false); // no ingredients/instructions
    expect(r.recipe.name).toBe("Some Blocked Recipe");
    expect(r.recipe.imageUrl).toBe("https://example.com/img/hero.png"); // resolved absolute
    expect(r.warnings.map((w) => w.field)).toContain("ingredients");
  });
});
