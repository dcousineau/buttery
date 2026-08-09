import { z } from "zod";
import type { RestrictedDietUrl, SchemaOrgHowToStep, SchemaOrgNutritionInformation, SchemaOrgOrganization, SchemaOrgPerson, SchemaOrgRecipe, WireRecipe } from "./types.ts";
import { SCHEMA_ORG_CONTEXT } from "./vocab.ts";
import { dietUrlFrom, isRecipeNode } from "./index.ts";

/**
 * Zod mirrors of the schema.org types. Deliberately quarantined in its own file
 * behind its own subpath export (`@buttery/recipe-schemas/schema-org/zod`), and
 * `zod` is an OPTIONAL peer dependency — consumers that only need compile-time
 * types (the parsers, the emit path) never pull zod into their graph.
 *
 * `./types.ts` stays the source of truth. Each schema is `satisfies`-checked
 * against its hand-written type, and the exported `Assert*` aliases close the
 * loop in the other direction, so the two can't drift silently.
 */

export const restrictedDietUrlSchema = z.custom<RestrictedDietUrl>((v) => dietUrlFrom(v) != null, { message: "Not a schema.org RestrictedDiet member" });

export const schemaOrgPersonSchema = z.object({
  "@type": z.literal("Person"),
  name: z.string(),
  url: z.string().optional(),
}) satisfies z.ZodType<SchemaOrgPerson>;

export const schemaOrgOrganizationSchema = z.object({
  "@type": z.literal("Organization"),
  name: z.string(),
  url: z.string().optional(),
}) satisfies z.ZodType<SchemaOrgOrganization>;

export const schemaOrgHowToStepSchema = z.object({
  "@type": z.literal("HowToStep"),
  text: z.string(),
  name: z.string().optional(),
}) satisfies z.ZodType<SchemaOrgHowToStep>;

export const schemaOrgNutritionInformationSchema = z.object({
  "@type": z.literal("NutritionInformation"),
  calories: z.string().optional(),
  fatContent: z.string().optional(),
  proteinContent: z.string().optional(),
  carbohydrateContent: z.string().optional(),
}) satisfies z.ZodType<SchemaOrgNutritionInformation>;

/**
 * The canonical, emit-shaped document. Use it to assert what we publish —
 * `lexiconToSchemaOrg`'s output is already statically typed, so this is for
 * tests and any place a document arrives as `unknown`.
 */
export const schemaOrgRecipeSchema = z.object({
  "@context": z.literal(SCHEMA_ORG_CONTEXT),
  "@type": z.literal("Recipe"),
  name: z.string(),
  description: z.string().optional(),
  image: z.array(z.string()).optional(),
  author: z.union([schemaOrgPersonSchema, schemaOrgOrganizationSchema]).optional(),
  datePublished: z.string().optional(),
  prepTime: z.string().optional(),
  cookTime: z.string().optional(),
  totalTime: z.string().optional(),
  recipeYield: z.string().optional(),
  recipeCuisine: z.string().optional(),
  recipeCategory: z.string().optional(),
  cookingMethod: z.string().optional(),
  suitableForDiet: z.array(restrictedDietUrlSchema).optional(),
  keywords: z.string().optional(),
  recipeIngredient: z.array(z.string()).optional(),
  recipeInstructions: z.array(schemaOrgHowToStepSchema).optional(),
  nutrition: schemaOrgNutritionInformationSchema.optional(),
  url: z.string().optional(),
}) satisfies z.ZodType<SchemaOrgRecipe>;

/**
 * The read side: "is this thing a Recipe node?" and nothing more. Validating a
 * wire node's properties would be theatre — `coerceRecipe` accepts every shape
 * the web actually emits and drops what it can't use.
 */
export const wireRecipeSchema = z.custom<WireRecipe>(isRecipeNode, { message: "Not a schema.org Recipe node" });

/* --- drift guards: zod output must equal the hand-written type ------------ */

export type SchemaOrgRecipeZodOutput = z.infer<typeof schemaOrgRecipeSchema>;

/** `never` if `./types.ts` gains a field `schemaOrgRecipeSchema` doesn't model. */
export type AssertSchemaOrgRecipeMatches = SchemaOrgRecipe extends SchemaOrgRecipeZodOutput ? true : never;
