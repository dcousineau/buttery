import type { ExtractedRecipe } from "@buttery/recipe-schemas/bridge";

/**
 * The extracted-recipe shape now lives with the schema crosswalks
 * (`@buttery/recipe-schemas/bridge`) — it's the lexicon side of every mapping,
 * not a parser concern. Re-exported here so callers keep one import.
 */
export type { ExtractedRecipe };

/** Which extraction path produced the primary result. `site:<host>` = a bespoke adapter. */
export type ExtractorName = "jsonld" | "microdata" | "hrecipe" | "heuristics" | `site:${string}`;

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
