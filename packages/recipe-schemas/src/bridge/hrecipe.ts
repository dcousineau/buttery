import type { RawHRecipe } from "../hrecipe/types.ts";
import { coerceHRecipe } from "../hrecipe/coerce.ts";
import type { ExtractedRecipe } from "./types.ts";

/**
 * microformats hRecipe → `exchange.recipe.recipe`. Read direction only; we don't
 * publish microformats.
 *
 * hRecipe carries strictly less than schema.org, so several lexicon fields have
 * no source here:
 *   - no controlled vocabularies at all — `category`/`tag` values are free text,
 *     so they land in `keywords`, not in `vocab.category` (which the app maps
 *     against the seeded vocab and would mostly miss).
 *   - no diet enumeration — nothing can populate `suitableForDiet`.
 *   - no structured nutrition — `nutrition` is prose ("410 calories per
 *     serving"), which the lexicon's numeric fields can't hold, so it's dropped.
 * `duration` is the recipe's total time; prep/cook only appear when a site
 * invents the non-standard classes for them.
 */
export function hRecipeToLexicon(raw: RawHRecipe, base: string): ExtractedRecipe {
  const c = coerceHRecipe(raw, base);
  const out: ExtractedRecipe = {};

  if (c.name) out.name = c.name;
  if (c.summary) out.text = c.summary;
  if (c.ingredients.length) out.ingredients = c.ingredients;
  if (c.instructions.length) out.instructions = c.instructions;
  if (c.prepTime) out.prepTime = c.prepTime;
  if (c.cookTime) out.cookTime = c.cookTime;
  if (c.totalTime) out.totalTime = c.totalTime;
  if (c.recipeYield) out.recipeYield = c.recipeYield;
  if (c.categories.length) out.keywords = c.categories;
  if (c.imageUrls.length) out.imageUrl = c.imageUrls[0];

  return out;
}
