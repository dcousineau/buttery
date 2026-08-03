import type { Main } from "@buttery/lexicons/exchange/recipe/recipe";

/**
 * What the extractor produces: the parts of an `exchange.recipe.recipe` record
 * we can pull from a page, minus the fields the server owns (`$type`, timestamps,
 * `attribution` — always re-derived from the source URL — and `embed` — built on
 * publish from the fetched image bytes).
 *
 * Controlled-vocabulary dimensions (cuisine / category / method / diet) are NOT
 * resolved to lexicon tokens here on purpose: that mapping lives in the web app's
 * `recipe-vocab` (the single source of truth mirroring the DB seed), so the
 * parser stays free of vocab drift. We surface the page's raw free-text values in
 * `vocab` and let the app map what it recognizes. `suitableForDiet` is the one
 * exception — schema.org's RestrictedDiet enum is a fixed, stable URL set, so we
 * resolve those to lexicon tokens directly (see normalize/diet).
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

/** Which extraction path produced the primary result. `site:<host>` = a bespoke adapter. */
export type ExtractorName = "jsonld" | "microdata" | "heuristics" | `site:${string}`;

/** Non-blocking note about something we couldn't confidently pull. */
export interface ExtractWarning {
  field: string;
  message: string;
}

export interface ExtractResult {
  /** True when we got a usable recipe: a name plus ingredients or instructions. */
  ok: boolean;
  /** Everything we could pull (may be partial even when `ok` is false). */
  recipe: ExtractedRecipe;
  /** The path that produced the recipe body, or null if nothing usable was found. */
  extractor: ExtractorName | null;
  warnings: ExtractWarning[];
}

/** Input to every parser and site adapter: the raw HTML and the page's own URL. */
export interface ExtractInput {
  html: string;
  url: string;
}

/**
 * A bespoke per-host extractor. Register one in `sites/index.ts` when a site
 * blocks structured data or ships broken/partial markup. Given the parsed page
 * it returns whatever it can (or null to fall through to the generic pipeline).
 */
export interface SiteExtractor {
  /** Bare hostnames this adapter handles, e.g. `["allrecipes.com"]`. */
  hosts: string[];
  extract(input: ParsedInput): ExtractedRecipe | null;
}

/** `ExtractInput` plus the parsed DOM root, handed to parsers/adapters. */
export interface ParsedInput extends ExtractInput {
  // node-html-parser's HTMLElement; typed loosely to keep this module dep-light.
  root: import("node-html-parser").HTMLElement;
}
