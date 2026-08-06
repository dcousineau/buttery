/**
 * Pure, framework-free draw logic for the meal randomizer (plan §5). The server
 * returns the eligible pool (`getRandomizerPool`); everything below — the
 * uniform draw, re-roll, no-repeat exclusion, and the plain-text share format —
 * runs client-side with no network round trip, so it is trivially unit-testable.
 */

/**
 * Draw one item uniformly at random from `pool`. When `excludeId` is set, that
 * id is excluded from the candidate set first (plan §5.3 no-repeat) — UNLESS
 * doing so would leave zero candidates (pool size 1), in which case it is drawn
 * again since there is nothing else to offer. Returns `null` for an empty pool.
 *
 * `rng` defaults to `Math.random` but accepts an injectable `() => number` in
 * `[0, 1)` so callers (tests) can make the draw deterministic.
 */
export function drawRandom<T extends { recipeId: string }>(pool: T[], excludeId: string | null, rng: () => number = Math.random): T | null {
  if (pool.length === 0) return null;

  const candidates = excludeId != null && pool.length > 1 ? pool.filter((item) => item.recipeId !== excludeId) : pool;

  const index = Math.floor(rng() * candidates.length);
  // Guard against rng() returning exactly 1 (out of spec, but cheap to clamp).
  const safeIndex = Math.min(index, candidates.length - 1);
  return candidates[safeIndex] ?? null;
}

/**
 * Build the plain-text share/copy summary (plan §8): name, blank line, then one
 * `- ingredient` per line. Total time and source URL are appended as trailing
 * lines when present. No markup — must paste cleanly into a text message.
 */
export function buildShareText(recipe: { title: string; ingredients: string[]; totalTimeDisplay?: string | null; sourceUrl?: string | null }): string {
  const lines = [recipe.title, "", ...recipe.ingredients.map((ingredient) => `- ${ingredient}`)];

  const trailer: string[] = [];
  if (recipe.totalTimeDisplay) trailer.push(`Total time: ${recipe.totalTimeDisplay}`);
  if (recipe.sourceUrl) trailer.push(recipe.sourceUrl);

  if (trailer.length > 0) {
    lines.push("", ...trailer);
  }

  return lines.join("\n");
}
