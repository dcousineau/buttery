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

describe("extractRecipe — microdata fallback, richer fields", () => {
  it("reads keywords, nutrition, diets and cuisine now that it shares the JSON-LD mapping", () => {
    const body = `
      <div itemscope itemtype="https://schema.org/Recipe">
        <h1 itemprop="name">Vegan Chili</h1>
        <meta itemprop="keywords" content="chili, weeknight">
        <meta itemprop="recipeCuisine" content="Tex-Mex">
        <meta itemprop="recipeCategory" content="Dinner">
        <link itemprop="suitableForDiet" href="https://schema.org/VeganDiet">
        <img itemprop="image" src="/img/chili.jpg">
        <li itemprop="recipeIngredient">1 can beans</li>
        <div itemprop="recipeInstructions" content="Simmer for an hour.">Simmer for ages</div>
        <div itemprop="nutrition" itemscope itemtype="https://schema.org/NutritionInformation">
          <meta itemprop="calories" content="380 calories">
          <meta itemprop="proteinContent" content="18 g">
        </div>
      </div>`;
    const r = extractRecipe({ url: URL, html: page("", body) });

    expect(r.extractor).toBe("microdata");
    expect(r.recipe.keywords).toEqual(["chili", "weeknight"]);
    expect(r.recipe.vocab).toEqual({ cuisine: "Tex-Mex", category: "Dinner", method: undefined });
    expect(r.recipe.suitableForDiet).toEqual(["exchange.recipe.defs#dietVegan"]);
    expect(r.recipe.nutrition).toEqual({ calories: 380, proteinContent: "18" });
    expect(r.recipe.imageUrl).toBe("https://example.com/img/chili.jpg");
    // The `content` attribute overrides visible text, per the microdata spec.
    expect(r.recipe.instructions).toEqual(["Simmer for an hour."]);
  });

  it("doesn't read a nested item's properties as the recipe's own", () => {
    const body = `
      <div itemscope itemtype="https://schema.org/Recipe">
        <h1 itemprop="name">Scoped</h1>
        <li itemprop="recipeIngredient">salt</li>
        <div itemprop="nutrition" itemscope itemtype="https://schema.org/NutritionInformation">
          <meta itemprop="calories" content="100 calories">
        </div>
      </div>`;
    const r = extractRecipe({ url: URL, html: page("", body) });
    expect(r.recipe.nutrition).toEqual({ calories: 100 });
  });
});

describe("extractRecipe — microformats hRecipe", () => {
  it("reads mf2 h-recipe markup", () => {
    const body = `
      <article class="h-recipe">
        <h1 class="p-name">Skillet Cornbread</h1>
        <p class="p-summary">Crisp edges, tender middle.</p>
        <img class="u-photo" src="/img/cornbread.jpg" alt="">
        <time class="dt-duration" datetime="PT45M">45 minutes</time>
        <p class="p-yield">One 10-inch skillet</p>
        <ul>
          <li class="p-ingredient">1 cup cornmeal</li>
          <li class="p-ingredient">1 cup buttermilk</li>
        </ul>
        <div class="e-instructions">
          <p>Heat the skillet.</p>
          <p>Pour and bake 25 minutes.</p>
        </div>
        <a class="p-category" href="/tags/bread">bread</a>
      </article>`;
    const r = extractRecipe({ url: URL, html: page("", body) });

    expect(r.ok).toBe(true);
    expect(r.extractor).toBe("hrecipe");
    expect(r.recipe.name).toBe("Skillet Cornbread");
    expect(r.recipe.text).toBe("Crisp edges, tender middle.");
    expect(r.recipe.ingredients).toEqual(["1 cup cornmeal", "1 cup buttermilk"]);
    expect(r.recipe.instructions).toEqual(["Heat the skillet.", "Pour and bake 25 minutes."]);
    expect(r.recipe.totalTime).toBe("PT45M");
    expect(r.recipe.recipeYield).toBe("One 10-inch skillet");
    expect(r.recipe.imageUrl).toBe("https://example.com/img/cornbread.jpg");
    expect(r.recipe.keywords).toEqual(["bread"]);
  });

  it("reads mf1 hrecipe markup, including the value-title pattern", () => {
    const body = `
      <div class="hrecipe">
        <h1 class="fn">Grandma's Biscuits</h1>
        <span class="duration"><span class="value-title" title="PT30M"> </span>half an hour</span>
        <p class="ingredient">2 cups flour</p>
        <p class="ingredient">1 stick butter</p>
        <div class="instructions">Cut in the butter.
Bake 12 minutes.</div>
        <a rel="tag" class="tag" href="/t/southern">southern</a>
      </div>`;
    const r = extractRecipe({ url: URL, html: page("", body) });

    expect(r.extractor).toBe("hrecipe");
    expect(r.recipe.name).toBe("Grandma's Biscuits");
    expect(r.recipe.ingredients).toEqual(["2 cups flour", "1 stick butter"]);
    expect(r.recipe.instructions).toEqual(["Cut in the butter.", "Bake 12 minutes."]);
    // "half an hour" is unparseable — the value-title carries the real duration.
    expect(r.recipe.totalTime).toBe("PT30M");
    expect(r.recipe.keywords).toEqual(["southern"]);
  });

  it("loses to schema.org when a page ships both", () => {
    const ld = { "@type": "Recipe", name: "From JSON-LD", recipeIngredient: ["salt"], recipeInstructions: ["Stir."] };
    const body = `<div class="h-recipe"><h1 class="p-name">From hRecipe</h1><li class="p-ingredient">pepper</li></div>`;
    const r = extractRecipe({ url: URL, html: page(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`, body) });
    expect(r.extractor).toBe("jsonld");
    expect(r.recipe.name).toBe("From JSON-LD");
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
