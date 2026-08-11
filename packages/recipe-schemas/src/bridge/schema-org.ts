import type { ParsedNutrition, SchemaOrgHowToStep, SchemaOrgOrganization, SchemaOrgPerson, SchemaOrgRecipe, WireRecipe } from "../schema-org/types.ts";
import { coerceRecipe } from "../schema-org/coerce.ts";
import { SCHEMA_ORG_CONTEXT } from "../schema-org/vocab.ts";
import { dietTokensFromSchemaOrg, dietUrlsForSlugs } from "./vocab.ts";
import type { ExtractedRecipe, LexiconNutrition } from "./types.ts";

/**
 * schema.org/Recipe ⇄ `exchange.recipe.recipe`. Both directions live together on
 * purpose: a field's two mappings are one decision, and splitting them is how
 * the diet tables drifted apart in the first place.
 */

/* --- read: page → lexicon ------------------------------------------------- */

/**
 * A schema.org Recipe node (from JSON-LD or assembled from microdata) → the
 * lexicon-shaped fields an import prefills. `base` is the page's own URL, used
 * to absolutize relative image URLs.
 *
 * Fields are omitted rather than set to `undefined`: the extractor merges
 * results from several sources by backfilling absent keys, so "not found" has to
 * mean the key isn't there.
 */
export function schemaOrgToLexicon(node: WireRecipe, base: string): ExtractedRecipe {
  const c = coerceRecipe(node, base);
  const out: ExtractedRecipe = {};

  if (c.name) out.name = c.name;
  if (c.description) out.text = c.description;
  if (c.ingredients.length) out.ingredients = c.ingredients;
  if (c.instructions.length) out.instructions = c.instructions;
  if (c.prepTime) out.prepTime = c.prepTime;
  if (c.cookTime) out.cookTime = c.cookTime;
  if (c.totalTime) out.totalTime = c.totalTime;
  if (c.recipeYield) out.recipeYield = c.recipeYield;
  if (c.keywords.length) out.keywords = c.keywords;
  if (c.imageUrls.length) out.imageUrl = c.imageUrls[0];

  const nutrition = toLexiconNutrition(c.nutrition);
  if (nutrition) out.nutrition = nutrition;

  const diets = dietTokensFromSchemaOrg(c.suitableForDiet);
  if (diets.length) out.suitableForDiet = diets;

  if (c.recipeCuisine || c.recipeCategory || c.cookingMethod) {
    out.vocab = { cuisine: c.recipeCuisine, category: c.recipeCategory, method: c.cookingMethod };
  }

  return out;
}

/** Parsed numbers → the lexicon's shape: kcal rounded, grams as decimal strings. */
function toLexiconNutrition(n: ParsedNutrition | undefined): LexiconNutrition | undefined {
  if (!n) return undefined;
  const out: LexiconNutrition = {};
  if (n.calories != null) out.calories = Math.round(n.calories);
  if (n.fatContent != null) out.fatContent = String(n.fatContent);
  if (n.proteinContent != null) out.proteinContent = String(n.proteinContent);
  if (n.carbohydrateContent != null) out.carbohydrateContent = String(n.carbohydrateContent);
  return Object.keys(out).length ? out : undefined;
}

/* --- write: our recipe → schema.org --------------------------------------- */

/**
 * What `lexiconToSchemaOrg` needs. Deliberately structural rather than the
 * lexicon record type: the web app emits from its own rendered read model
 * (`RecipeDetailData`), which carries app vocab slugs and display strings, not
 * lexicon tokens. Callers map onto this; the crosswalk owns everything after.
 */
export interface SchemaOrgEmitSource {
  name: string;
  description?: string | null;
  /** Absolute image URLs, hero first. */
  imageUrls?: readonly string[];
  author?: SchemaOrgEmitAuthor | null;
  datePublished?: string | null;
  /** ISO-8601 durations — already schema.org's expected form. */
  prepTime?: string | null;
  cookTime?: string | null;
  totalTime?: string | null;
  recipeYield?: string | null;
  cuisine?: string | null;
  category?: string | null;
  cookingMethod?: string | null;
  /** App diet slugs; ones with no RestrictedDiet member are dropped. */
  dietSlugs?: readonly string[];
  keywords?: readonly string[];
  ingredients?: readonly string[];
  instructions?: readonly string[];
  calories?: number | null;
  url?: string | null;
}

export interface SchemaOrgEmitAuthor {
  name: string;
  /**
   * The atproto attribution kind (person / organization / publication / …).
   * Anything that isn't clearly a person is safest typed as an Organization.
   */
  kind?: string | null;
  url?: string | null;
}

/**
 * Build a canonical JSON-LD https://schema.org/Recipe document. Absent fields are
 * omitted, never emitted as `null` — a JSON-LD consumer reads `null` as a real
 * value. The return type is the type fence: a field that isn't on
 * `SchemaOrgRecipe` can't be shipped by accident.
 */
export function lexiconToSchemaOrg(source: SchemaOrgEmitSource): SchemaOrgRecipe {
  const doc: SchemaOrgRecipe = {
    "@context": SCHEMA_ORG_CONTEXT,
    "@type": "Recipe",
    name: source.name,
  };

  const description = text(source.description);
  if (description) doc.description = description;
  if (source.imageUrls?.length) doc.image = [...source.imageUrls];

  const author = toAuthor(source.author);
  if (author) doc.author = author;

  const datePublished = text(source.datePublished);
  if (datePublished) doc.datePublished = datePublished;

  const prepTime = text(source.prepTime);
  if (prepTime) doc.prepTime = prepTime;
  const cookTime = text(source.cookTime);
  if (cookTime) doc.cookTime = cookTime;
  const totalTime = text(source.totalTime);
  if (totalTime) doc.totalTime = totalTime;

  const recipeYield = text(source.recipeYield);
  if (recipeYield) doc.recipeYield = recipeYield;
  const cuisine = text(source.cuisine);
  if (cuisine) doc.recipeCuisine = cuisine;
  const category = text(source.category);
  if (category) doc.recipeCategory = category;
  const cookingMethod = text(source.cookingMethod);
  if (cookingMethod) doc.cookingMethod = cookingMethod;

  const diets = dietUrlsForSlugs(source.dietSlugs);
  if (diets.length) doc.suitableForDiet = diets;

  // schema.org wants keywords as one comma-separated string.
  if (source.keywords?.length) doc.keywords = source.keywords.join(", ");
  if (source.ingredients?.length) doc.recipeIngredient = [...source.ingredients];
  if (source.instructions?.length) doc.recipeInstructions = source.instructions.map(toHowToStep);
  if (source.calories != null) doc.nutrition = { "@type": "NutritionInformation", calories: `${source.calories} calories` };

  const url = text(source.url);
  if (url) doc.url = url;

  return doc;
}

function toHowToStep(step: string): SchemaOrgHowToStep {
  return { "@type": "HowToStep", text: step };
}

function toAuthor(author: SchemaOrgEmitAuthor | null | undefined): SchemaOrgPerson | SchemaOrgOrganization | undefined {
  const name = text(author?.name);
  if (!author || !name) return undefined;
  const url = text(author.url);
  if (author.kind === "person") return url ? { "@type": "Person", name, url } : { "@type": "Person", name };
  return url ? { "@type": "Organization", name, url } : { "@type": "Organization", name };
}

function text(v: string | null | undefined): string | undefined {
  const s = v?.trim();
  return s ? s : undefined;
}
