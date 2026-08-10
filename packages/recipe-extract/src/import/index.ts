/**
 * `@buttery/recipe-extract/import` — the importer seam (§2.5).
 *
 * Generic by construction: nothing under `src/import/` may import from `src/paprika/`,
 * and no module in the import pipeline may import from `@buttery/recipe-extract/paprika`.
 * That one property is what makes the second importer a new module rather than a refactor.
 */
export * from "./types.ts";
export * from "./entry-source.ts";
