/**
 * @buttery/recipe-schemas — the recipe interchange vocabularies Buttery speaks,
 * co-located so each can be read and updated against its own spec.
 *
 *   schema-org/  https://schema.org/Recipe — read (imports) and write (JSON-LD)
 *   hrecipe/     https://microformats.org/wiki/hrecipe + mf2 h-recipe — read
 *   bridge/      crosswalks to `exchange.recipe.*`, the atproto lexicon that
 *                stays the canonical model (and lives in @buttery/lexicons)
 *   normalize/   shared value cleanup (whitespace, URLs, ISO-8601 durations)
 *
 * Pure data: no DOM, no network, no runtime dependencies. Finding a recipe in an
 * HTML document is @buttery/recipe-extract's job — this package only says what a
 * recipe looks like in each vocabulary and how the vocabularies line up.
 *
 * Zod mirrors of every type exist behind separate `<vocabulary>/zod` subpath
 * exports, and `zod` is an optional peer dependency, so importing types from
 * here costs nothing.
 */

export type { ExtractedRecipe, LexiconNutrition } from "./bridge/types.ts";
export type { CoercedSchemaOrgRecipe, RestrictedDietMember, RestrictedDietUrl, SchemaOrgRecipe, WireRecipe } from "./schema-org/types.ts";
export type { CoercedHRecipe, HRecipeProperty, RawHRecipe } from "./hrecipe/types.ts";
