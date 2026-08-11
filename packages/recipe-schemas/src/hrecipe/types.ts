/**
 * microformats hRecipe — https://microformats.org/wiki/hrecipe (mf1) and its
 * mf2 successor `h-recipe`.
 *
 * Unlike schema.org, microformats have no object model on the wire: a page just
 * puts class names on elements, and every value is a string (or a subtree of
 * strings). So the read layer is two types:
 *
 *   - `RawHRecipe` — the strings a DOM walker collected per property, in
 *     document order. Whoever holds the DOM fills this in; the class names to
 *     look for are in `classes.ts`.
 *   - `CoercedHRecipe` — the same data cleaned: single-valued properties
 *     collapsed, durations ISO-normalized, photo URLs absolutized.
 *
 * hRecipe has no nutrition breakdown and no controlled vocabularies, so there is
 * less to model here than schema.org — that asymmetry is the format's, not ours.
 */

/**
 * Every hRecipe property we read. Names are ours (camelCase); the mf1/mf2 class
 * names each maps to live in `classes.ts`.
 */
export type HRecipeProperty =
  | "name"
  | "summary"
  | "ingredient"
  | "instructions"
  | "yield"
  | "duration"
  | "prepTime"
  | "cookTime"
  | "photo"
  | "nutrition"
  | "author"
  | "published"
  | "category";

/** Raw property values collected from one h-recipe subtree, in document order. */
export type RawHRecipe = Partial<Record<HRecipeProperty, string[]>>;

/** A `RawHRecipe` after `coerceHRecipe`. Still pure microformats. */
export interface CoercedHRecipe {
  name?: string;
  summary?: string;
  ingredients: string[];
  instructions: string[];
  recipeYield?: string;
  /** mf1 `duration` / mf2 `dt-duration` — the recipe's total time. */
  totalTime?: string;
  prepTime?: string;
  cookTime?: string;
  imageUrls: string[];
  /** Free text ("410 calories per serving") — hRecipe has no structured form. */
  nutrition: string[];
  author?: string;
  published?: string;
  categories: string[];
}
