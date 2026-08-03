import type { ExtractedRecipe, ParsedInput } from "../types.ts";
import { absoluteUrl, cleanText, firstString, toStringList } from "../normalize/text.ts";
import { toIsoDuration } from "../normalize/duration.ts";
import { dietTokens } from "../normalize/diet.ts";

/**
 * schema.org/Recipe from `<script type="application/ld+json">`. The richest and
 * most reliable source, so it runs first. Handles the shapes real sites emit:
 * `@graph` wrappers, top-level arrays, `@type` as a string or array, and
 * instructions as strings, `HowToStep`s, or `HowToSection`s of steps.
 */
export function fromJsonLd({ root, url }: ParsedInput): ExtractedRecipe | null {
  const node = findRecipeNode(root);
  if (!node) return null;
  return mapRecipe(node, url);
}

/** True if `@type` (string or array) contains "Recipe". */
function isRecipeType(type: unknown): boolean {
  if (typeof type === "string") return /(^|\W)Recipe$/i.test(type) || type.toLowerCase() === "recipe";
  if (Array.isArray(type)) return type.some(isRecipeType);
  return false;
}

/** Walk every ld+json block (and nested @graph/arrays) for the first Recipe node. */
function findRecipeNode(root: ParsedInput["root"]): Record<string, unknown> | null {
  const scripts = root.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    let data: unknown;
    try {
      // rawText avoids the parser's entity decoding corrupting the JSON payload.
      data = JSON.parse(script.rawText.trim());
    } catch {
      continue;
    }
    const found = search(data);
    if (found) return found;
  }
  return null;
}

function search(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = search(item);
      if (found) return found;
    }
    return null;
  }
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (isRecipeType(obj["@type"])) return obj;
    if (obj["@graph"]) return search(obj["@graph"]);
  }
  return null;
}

function mapRecipe(node: Record<string, unknown>, url: string): ExtractedRecipe {
  const out: ExtractedRecipe = {};

  const name = cleanText(node.name);
  if (name) out.name = name;

  const text = cleanText(node.description);
  if (text) out.text = text;

  const ingredients = toStringList(node.recipeIngredient ?? node.ingredients);
  if (ingredients.length) out.ingredients = ingredients;

  const instructions = mapInstructions(node.recipeInstructions);
  if (instructions.length) out.instructions = instructions;

  const prep = toIsoDuration(node.prepTime);
  if (prep) out.prepTime = prep;
  const cook = toIsoDuration(node.cookTime);
  if (cook) out.cookTime = cook;
  const total = toIsoDuration(node.totalTime);
  if (total) out.totalTime = total;

  const yieldStr = firstString(node.recipeYield) ?? (typeof node.recipeYield === "number" ? String(node.recipeYield) : undefined);
  if (yieldStr) out.recipeYield = yieldStr;

  const keywords = mapKeywords(node.keywords);
  if (keywords.length) out.keywords = keywords;

  const image = mapImage(node.image, url);
  if (image) out.imageUrl = image;

  const nutrition = mapNutrition(node.nutrition);
  if (nutrition) out.nutrition = nutrition;

  const diets = dietTokens(node.suitableForDiet);
  if (diets) out.suitableForDiet = diets as ExtractedRecipe["suitableForDiet"];

  const cuisine = firstString(node.recipeCuisine);
  const category = firstString(node.recipeCategory);
  const method = firstString(node.cookingMethod);
  if (cuisine || category || method) out.vocab = { cuisine, category, method };

  return out;
}

/** recipeInstructions → flat step strings (string | HowToStep | HowToSection). */
function mapInstructions(v: unknown): string[] {
  if (v == null) return [];
  if (typeof v === "string") {
    // A single blob — split on newlines (many sites do this).
    return v
      .split(/\r?\n/)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }
  if (!Array.isArray(v)) return stepText(v);
  const out: string[] = [];
  for (const item of v) out.push(...stepText(item));
  return out;
}

function stepText(item: unknown): string[] {
  if (typeof item === "string") {
    const s = cleanText(item);
    return s ? [s] : [];
  }
  if (!item || typeof item !== "object") return [];
  const obj = item as Record<string, unknown>;
  const type = obj["@type"];
  // HowToSection → recurse into its steps.
  if ((typeof type === "string" && /HowToSection/i.test(type)) || obj.itemListElement) {
    return mapInstructions(obj.itemListElement);
  }
  // HowToStep (or a bare {text}/{name}) → its text.
  const s = cleanText(obj.text) ?? cleanText(obj.name);
  return s ? [s] : [];
}

function mapKeywords(v: unknown): string[] {
  if (typeof v === "string") {
    return v
      .split(",")
      .map((k) => k.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }
  return toStringList(v);
}

/** image → first absolute URL (string | ImageObject | array of either). */
function mapImage(v: unknown, base: string): string | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) {
    for (const item of v) {
      const u = mapImage(item, base);
      if (u) return u;
    }
    return undefined;
  }
  if (typeof v === "string") return absoluteUrl(base, v);
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return absoluteUrl(base, obj.url) ?? absoluteUrl(base, obj.contentUrl);
  }
  return undefined;
}

function mapNutrition(v: unknown): ExtractedRecipe["nutrition"] | undefined {
  if (!v || typeof v !== "object") return undefined;
  const obj = v as Record<string, unknown>;
  const calories = parseCalories(obj.calories);
  const fat = parseGrams(obj.fatContent);
  const protein = parseGrams(obj.proteinContent);
  const carbs = parseGrams(obj.carbohydrateContent);
  if (calories == null && fat == null && protein == null && carbs == null) return undefined;
  const out: NonNullable<ExtractedRecipe["nutrition"]> = {};
  if (calories != null) out.calories = calories;
  if (fat != null) out.fatContent = fat;
  if (protein != null) out.proteinContent = protein;
  if (carbs != null) out.carbohydrateContent = carbs;
  return out;
}

/** "210 calories" | "210" | 210 → 210. */
function parseCalories(v: unknown): number | undefined {
  const n = firstNumber(v);
  return n != null ? Math.round(n) : undefined;
}
/** "11 g" | "11" → "11" (lexicon stores grams as a decimal string). */
function parseGrams(v: unknown): string | undefined {
  const n = firstNumber(v);
  return n != null ? String(n) : undefined;
}
function firstNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = /(\d+(?:\.\d+)?)/.exec(v);
    if (m) return parseFloat(m[1]);
  }
  return undefined;
}
