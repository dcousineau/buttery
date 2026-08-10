/**
 * `@buttery/recipe-extract/paprika` — the one importer phase 1 ships (§4).
 *
 * This subpath may import from `../import/`; nothing under `../import/` may import from
 * here, and no module in the import pipeline may import this subpath at all. The single
 * legal consumer is the web app's importer registry
 * (`services/web/src/lib/recipe-import/importers.ts`). An ESLint `no-restricted-imports`
 * block enforces both directions — see plan §2.5 / D30 and acceptance criterion §16.19.
 */
export { walkPaprikaExport, PaprikaExportError } from "./export.ts";
export { parsePaprikaRecipe } from "./recipe.ts";
export { paprikaImporter, PAPRIKA_DROP_COPY } from "./importer.ts";
