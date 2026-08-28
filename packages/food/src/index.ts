/**
 * @buttery/food — ingredient-line -> food identity, and everything that hangs
 * off it: aisles, unit conversion, the Open Food Facts-derived lexicon, and
 * its derived vegan/vegetarian/allergen/tag traits.
 *
 *   aisles/      the 14 curated grocery aisles
 *   normalize/   shared text normalization the lexicon and matcher both use
 *   parse/       free-text ingredient line -> { quantity, unit, name, note }
 *   units/       unit resolution, conversion, and rendering for merged totals
 *   categorize/  ingredient name -> food -> aisle, over the vendored lexicon
 *   traits/      food -> vegan/vegetarian/allergen/tag facts (SERVER ONLY —
 *                see the module doc in `traits.ts`, plan D9)
 *   classify/    traits -> rules-based recipe allergen/diet verdicts
 *                (SERVER ONLY, inherited from `traits.ts` — see `classify.ts`'s
 *                module doc). Internals live in `classifiers/`.
 *
 * Pure and dependency-free apart from `parse-ingredient`: no DB, no DOM, so the
 * identical modules run in a browser, a server function, and the pipeline.
 * `categorize.ts` and `traits.ts` each reach their JSON through a dynamic
 * `import()`, so importing this barrel does not pull either into a bundle
 * that never uses it.
 */

export * from "./aisles.ts";
export * from "./normalize.ts";
export * from "./parse.ts";
export * from "./units.ts";
export * from "./categorize.ts";
export * from "./traits.ts";
export * from "./classify.ts";
