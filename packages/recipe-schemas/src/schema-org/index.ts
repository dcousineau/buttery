/**
 * https://schema.org/Recipe — types, controlled values, and the coercion that
 * turns a page's node into one predictable shape.
 *
 * Runtime-dependency-free by design: `import`ing this never pulls in zod (that
 * lives behind `@buttery/recipe-schemas/schema-org/zod`), a DOM, or the atproto
 * lexicon. Finding the node in a document is the caller's job — see
 * `@buttery/recipe-extract` — and mapping it to a lexicon record is
 * `@buttery/recipe-schemas/bridge`'s.
 */
export type {
  CoercedSchemaOrgRecipe,
  OneOrMany,
  ParsedNutrition,
  RestrictedDietMember,
  RestrictedDietUrl,
  SchemaOrgHowToSection,
  SchemaOrgHowToStep,
  SchemaOrgImageObject,
  SchemaOrgNutritionInformation,
  SchemaOrgOrganization,
  SchemaOrgPerson,
  SchemaOrgRecipe,
  WireRecipe,
} from "./types.ts";

export { RESTRICTED_DIET_MEMBERS, SCHEMA_ORG_CONTEXT, SCHEMA_ORG_PREFIX, dietMember, dietUrl, dietUrlFrom } from "./vocab.ts";

export { coerceDiets, coerceImages, coerceInstructions, coerceKeywords, coerceNutrition, coerceRecipe, coerceYield, isRecipeNode, isRecipeType } from "./coerce.ts";
