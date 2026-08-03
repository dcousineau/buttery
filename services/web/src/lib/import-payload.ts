import type { ExtractedRecipe } from "@buttery/recipe-extract";

/**
 * The prefill the create form loads when a recipe is imported. It is never
 * carried in the URL — it's cached server-side (on the import attempt row) and
 * fetched by an opaque import id (`?import=<id>` → getImportPrefill). Both import
 * transports converge on this one shape and mechanism:
 *   - Phase B server scrape → scrapeRecipe fetches + parses, caches, returns id.
 *   - Phase C bookmarklet → extracts on the hostile page, POSTs the result to the
 *     server (which caches it the same way and returns an id), then opens the
 *     form at `?import=<id>`.
 *
 * `sourceUrl` locks Website attribution on the form; `recipe` is the extracted,
 * lexicon-shaped fields (tokens / ISO durations / raw vocab — the form maps them).
 */
export interface ImportPrefill {
  sourceUrl: string;
  recipe: ExtractedRecipe;
}
