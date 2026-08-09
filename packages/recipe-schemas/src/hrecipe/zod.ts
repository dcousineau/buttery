import { z } from "zod";
import type { CoercedHRecipe, HRecipeProperty, RawHRecipe } from "./types.ts";
import { HRECIPE_PROPERTY_CLASSES } from "./classes.ts";

/**
 * Zod mirrors of the hRecipe types, quarantined behind
 * `@buttery/recipe-schemas/hrecipe/zod` so the optional `zod` peer stays
 * optional. `./types.ts` remains the source of truth; the `satisfies` checks and
 * the `Assert*` aliases keep the two in step.
 *
 * Useful mainly at trust boundaries — a `RawHRecipe` posted by the bookmarklet
 * from a page we don't control is `unknown` until something says otherwise.
 */

const HRECIPE_PROPERTIES = Object.keys(HRECIPE_PROPERTY_CLASSES) as HRecipeProperty[];

export const hRecipePropertySchema = z.enum(HRECIPE_PROPERTIES as [HRecipeProperty, ...HRecipeProperty[]]);

export const rawHRecipeSchema = z.partialRecord(hRecipePropertySchema, z.array(z.string())) satisfies z.ZodType<RawHRecipe>;

export const coercedHRecipeSchema = z.object({
  name: z.string().optional(),
  summary: z.string().optional(),
  ingredients: z.array(z.string()),
  instructions: z.array(z.string()),
  recipeYield: z.string().optional(),
  totalTime: z.string().optional(),
  prepTime: z.string().optional(),
  cookTime: z.string().optional(),
  imageUrls: z.array(z.string()),
  nutrition: z.array(z.string()),
  author: z.string().optional(),
  published: z.string().optional(),
  categories: z.array(z.string()),
}) satisfies z.ZodType<CoercedHRecipe>;

/* --- drift guards: zod output must equal the hand-written type ------------ */

export type CoercedHRecipeZodOutput = z.infer<typeof coercedHRecipeSchema>;

/** `never` if `./types.ts` gains a field `coercedHRecipeSchema` doesn't model. */
export type AssertCoercedHRecipeMatches = CoercedHRecipe extends CoercedHRecipeZodOutput ? true : never;
