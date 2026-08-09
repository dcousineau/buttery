/**
 * @buttery/recipe-extract — pure, portable recipe extraction from raw HTML.
 *
 * No network, no DB, no framework. The web app fetches a page (SSRF-guarded) and
 * hands the bytes here; a future browser bundle (the Phase C bookmarklet) will
 * run this same code against a page's live DOM-serialized HTML. Keeping it pure
 * is what lets both callers — and a future scrape worker — share one parser.
 *
 * This package owns DOM work only: finding a recipe in a document. What the
 * markup MEANS — schema.org and hRecipe property names, their coercion, and the
 * crosswalk to the lexicon — lives in `@buttery/recipe-schemas`.
 *
 * See docs/plans/2026-08-02-create-recipes.md §B3.
 */
export { extractRecipe } from "./extract.ts";
export { findSiteExtractor } from "./sites/index.ts";
export type { ExtractInput, ExtractResult, ExtractedRecipe, ExtractorName, ExtractWarning, SiteExtractor, ParsedInput } from "./types.ts";
