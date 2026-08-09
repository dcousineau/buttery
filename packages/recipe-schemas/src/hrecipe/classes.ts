import type { HRecipeProperty } from "./types.ts";

/**
 * The class names a DOM walker looks for, per property. Both generations are
 * listed because both are live on the web: mf2 (`h-recipe`, prefixed properties)
 * is current, mf1 (`hrecipe`, bare properties) is what the original
 * https://microformats.org/wiki/hrecipe page documents and what older food blogs
 * still ship. mf2 names come first — when a page marks up both, the newer,
 * unambiguous one wins.
 *
 * Class names are matched case-insensitively (HTML class matching is
 * case-sensitive, but authors are not; `dt-prepTime` shows up in the wild).
 */

/** Root class names that open an hRecipe subtree. */
export const HRECIPE_ROOT_CLASSES = ["h-recipe", "hrecipe"] as const;

export const HRECIPE_PROPERTY_CLASSES: Record<HRecipeProperty, readonly string[]> = {
  name: ["p-name", "fn"],
  summary: ["p-summary", "summary"],
  ingredient: ["p-ingredient", "e-ingredient", "ingredient"],
  instructions: ["e-instructions", "p-instructions", "instructions"],
  yield: ["p-yield", "yield"],
  duration: ["dt-duration", "duration"],
  // Not in either spec — sites that want a prep/cook split invent these, and
  // they cost nothing to read.
  prepTime: ["dt-preptime", "dt-prep-time", "preptime"],
  cookTime: ["dt-cooktime", "dt-cook-time", "cooktime"],
  photo: ["u-photo", "photo"],
  nutrition: ["p-nutrition", "nutrition"],
  author: ["p-author", "author"],
  published: ["dt-published", "published"],
  category: ["p-category", "category", "tag"],
};

/**
 * mf1's `value-title` / `value-class` pattern: the machine-readable value lives
 * on a nested element rather than in the visible text, e.g.
 * `<span class="duration"><span class="value-title" title="PT30M"> </span>30 min</span>`.
 */
export const HRECIPE_VALUE_CLASSES = ["value-title", "value"] as const;

/** Property → the union of class names to match, mf2 first. */
export function classesFor(property: HRecipeProperty): readonly string[] {
  return HRECIPE_PROPERTY_CLASSES[property];
}
