/**
 * The crosswalks between the interchange vocabularies and Buttery's own model
 * (`exchange.recipe.*`). This is the ONLY directory that imports both a foreign
 * schema and the lexicon — `../schema-org` and `../hrecipe` stay ignorant of
 * each other and of us, so each can be updated against its own spec.
 *
 * `@buttery/lexicons` is used for types only; nothing here imports it at runtime.
 */
export type { ExtractedRecipe, LexiconNutrition } from "./types.ts";
export type { DietMapping } from "./vocab.ts";
export { DIET_MAPPINGS, dietSlugFromToken, dietToken, dietTokenFromSchemaOrg, dietTokensFromSchemaOrg, dietUrlForSlug, dietUrlsForSlugs } from "./vocab.ts";

export type { SchemaOrgEmitAuthor, SchemaOrgEmitSource } from "./schema-org.ts";
export { lexiconToSchemaOrg, schemaOrgToLexicon } from "./schema-org.ts";

export { hRecipeToLexicon } from "./hrecipe.ts";
