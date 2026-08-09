import type { CoercedHRecipe, RawHRecipe } from "./types.ts";
import { absoluteUrl, cleanText, splitLines, toStringList } from "../normalize/text.ts";
import { toIsoDuration } from "../normalize/duration.ts";

/**
 * `RawHRecipe` → `CoercedHRecipe`. Microformats carry no types, so this is where
 * "30 min" becomes `PT30M` and a one-blob `instructions` becomes steps.
 */
export function coerceHRecipe(raw: RawHRecipe, base: string): CoercedHRecipe {
  return {
    name: first(raw.name),
    summary: first(raw.summary),
    ingredients: toStringList(raw.ingredient),
    instructions: coerceHRecipeInstructions(raw.instructions),
    recipeYield: first(raw.yield),
    totalTime: firstDuration(raw.duration),
    prepTime: firstDuration(raw.prepTime),
    cookTime: firstDuration(raw.cookTime),
    imageUrls: (raw.photo ?? []).map((p) => absoluteUrl(base, p)).filter((u): u is string => !!u),
    nutrition: toStringList(raw.nutrition),
    author: first(raw.author),
    published: first(raw.published),
    categories: toStringList(raw.category),
  };
}

/**
 * hRecipe's `instructions` is one element holding the whole method, so steps
 * arrive as a single blob far more often than as a list. Split on lines when we
 * only got one value; otherwise the page already separated them for us.
 */
export function coerceHRecipeInstructions(values: string[] | undefined): string[] {
  if (!values?.length) return [];
  if (values.length > 1) return toStringList(values);
  const lines = splitLines(values[0]);
  return lines.length ? lines : toStringList(values);
}

function first(values: string[] | undefined): string | undefined {
  for (const v of values ?? []) {
    const s = cleanText(v);
    if (s) return s;
  }
  return undefined;
}

function firstDuration(values: string[] | undefined): string | undefined {
  for (const v of values ?? []) {
    const iso = toIsoDuration(v);
    if (iso) return iso;
  }
  return undefined;
}
