/**
 * microformats hRecipe (mf1) / h-recipe (mf2) — property names, class-name
 * tables, and coercion. Import direction only: Buttery emits schema.org
 * (JSON-LD + microdata) and doesn't publish microformats.
 *
 * Same rules as the schema.org module: no zod (that's
 * `@buttery/recipe-schemas/hrecipe/zod`), no DOM, no lexicon.
 */
export type { CoercedHRecipe, HRecipeProperty, RawHRecipe } from "./types.ts";
export { HRECIPE_PROPERTY_CLASSES, HRECIPE_ROOT_CLASSES, HRECIPE_VALUE_CLASSES, classesFor } from "./classes.ts";
export { coerceHRecipe, coerceHRecipeInstructions } from "./coerce.ts";
