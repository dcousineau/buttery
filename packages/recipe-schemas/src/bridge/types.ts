import type { Main } from "@buttery/lexicons/exchange/recipe/recipe";

/**
 * The lexicon-facing shapes the crosswalks read and write. `@buttery/lexicons`
 * is imported for TYPES ONLY — the tokens this module produces are plain string
 * literals, so nothing here reaches the lexicon at runtime.
 */

/**
 * What an extractor produces: the parts of an `exchange.recipe.recipe` record we
 * can pull from a page, minus the fields the server owns (`$type`, timestamps,
 * `attribution` — always re-derived from the source URL — and `embed` — built on
 * publish from the fetched image bytes).
 *
 * Controlled-vocabulary dimensions (cuisine / category / method) are NOT resolved
 * to lexicon tokens here on purpose: that mapping lives in the web app's
 * `recipe-vocab` (the single source of truth mirroring the DB seed), so the
 * parser stays free of vocab drift. We surface the page's raw free-text values in
 * `vocab` and let the app map what it recognizes. Diet is the one exception —
 * schema.org's RestrictedDiet is a fixed, stable enum, so it resolves to lexicon
 * tokens directly (see `./vocab.ts`).
 */
export type ExtractedRecipe = Partial<
  Pick<Main, "name" | "text" | "ingredients" | "instructions" | "keywords" | "prepTime" | "cookTime" | "totalTime" | "recipeYield" | "nutrition" | "suitableForDiet">
> & {
  /** Absolute URL of the page's hero image, if found. Fetched + uploaded later. */
  imageUrl?: string;
  /** Raw, unresolved free-text vocab values for the app to best-effort map. */
  vocab?: {
    cuisine?: string;
    category?: string;
    method?: string;
  };
};

/** The lexicon's nutrition sub-record: kcal as a number, grams as decimal strings. */
export type LexiconNutrition = NonNullable<ExtractedRecipe["nutrition"]>;
