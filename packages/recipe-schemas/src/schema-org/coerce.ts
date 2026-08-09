import type { CoercedSchemaOrgRecipe, ParsedNutrition, RestrictedDietUrl, WireRecipe } from "./types.ts";
import { dietUrlFrom } from "./vocab.ts";
import { absoluteUrl, cleanText, firstString, toStringList } from "../normalize/text.ts";
import { toIsoDuration } from "../normalize/duration.ts";

/**
 * `WireRecipe` → `CoercedSchemaOrgRecipe`: collapse every property schema.org
 * (and the real web) lets be polymorphic down to one form. This is the single
 * place that knows how sites bend the spec — JSON-LD and microdata both come
 * through here, so a fix for one is a fix for both.
 */

/** True if a node's `@type` (string or array, possibly a URL) names a Recipe. */
export function isRecipeType(type: unknown): boolean {
  if (typeof type === "string") return /(^|\W)Recipe$/i.test(type) || type.toLowerCase() === "recipe";
  if (Array.isArray(type)) return type.some(isRecipeType);
  return false;
}

/** Type guard for "this object looks like a schema.org Recipe node". */
export function isRecipeNode(value: unknown): value is WireRecipe {
  return !!value && typeof value === "object" && isRecipeType((value as WireRecipe)["@type"]);
}

/** Narrow every property of a wire Recipe node. `base` resolves relative URLs. */
export function coerceRecipe(node: WireRecipe, base: string): CoercedSchemaOrgRecipe {
  return {
    name: cleanText(node.name),
    description: cleanText(node.description),
    imageUrls: coerceImages(node.image, base),
    ingredients: toStringList(node.recipeIngredient ?? node.ingredients),
    instructions: coerceInstructions(node.recipeInstructions),
    prepTime: toIsoDuration(node.prepTime),
    cookTime: toIsoDuration(node.cookTime),
    totalTime: toIsoDuration(node.totalTime),
    recipeYield: coerceYield(node.recipeYield),
    keywords: coerceKeywords(node.keywords),
    suitableForDiet: coerceDiets(node.suitableForDiet),
    recipeCuisine: firstString(node.recipeCuisine),
    recipeCategory: firstString(node.recipeCategory),
    cookingMethod: firstString(node.cookingMethod),
    nutrition: coerceNutrition(node.nutrition),
    datePublished: cleanText(node.datePublished),
    url: cleanText(node.url),
  };
}

/** `recipeInstructions` → flat step strings (string | HowToStep | HowToSection). */
export function coerceInstructions(v: unknown): string[] {
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
    return coerceInstructions(obj.itemListElement);
  }
  // HowToStep (or a bare {text}/{name}) → its text.
  const s = cleanText(obj.text) ?? cleanText(obj.name);
  return s ? [s] : [];
}

/** `keywords` → a list, whether the page sent a comma string or an array. */
export function coerceKeywords(v: unknown): string[] {
  if (typeof v === "string") {
    return v
      .split(",")
      .map((k) => k.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }
  return toStringList(v);
}

/** `image` → absolute URLs (string | ImageObject | array of either). */
export function coerceImages(v: unknown, base: string): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap((item) => coerceImages(item, base));
  if (typeof v === "string") {
    const u = absoluteUrl(base, v);
    return u ? [u] : [];
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const u = absoluteUrl(base, obj.url) ?? absoluteUrl(base, obj.contentUrl);
    return u ? [u] : [];
  }
  return [];
}

/** `recipeYield` is routinely a bare number ("4 servings" vs `4`). */
export function coerceYield(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return firstString(v);
}

/** `suitableForDiet` → deduped canonical RestrictedDiet URLs; unknowns dropped. */
export function coerceDiets(v: unknown): RestrictedDietUrl[] {
  const arr = Array.isArray(v) ? v : [v];
  return [...new Set(arr.map(dietUrlFrom).filter((u): u is RestrictedDietUrl => u != null))];
}

/** `nutrition` → numbers, with schema.org's baked-in units ("11 g") stripped. */
export function coerceNutrition(v: unknown): ParsedNutrition | undefined {
  if (!v || typeof v !== "object") return undefined;
  const obj = v as Record<string, unknown>;
  const out: ParsedNutrition = {};
  const calories = firstNumber(obj.calories);
  const fat = firstNumber(obj.fatContent);
  const protein = firstNumber(obj.proteinContent);
  const carbs = firstNumber(obj.carbohydrateContent);
  if (calories != null) out.calories = calories;
  if (fat != null) out.fatContent = fat;
  if (protein != null) out.proteinContent = protein;
  if (carbs != null) out.carbohydrateContent = carbs;
  return Object.keys(out).length ? out : undefined;
}

/** "210 calories" | "11 g" | "11" | 11 → 11. */
function firstNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = /(\d+(?:\.\d+)?)/.exec(v);
    if (m) return parseFloat(m[1]);
  }
  return undefined;
}
