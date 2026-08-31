/**
 * Draw / re-roll / no-repeat logic for the meal randomizer. See
 * `docs/plans/2026-08-30-meal-randomizer.md` §5 (all subsections).
 *
 * Pure and dependency-light: no React, no server fn, no DB. The server-fetched
 * pool (§4) is a plain array the CLIENT holds; everything past that point —
 * picking a card, re-rolling, remembering "don't repeat that one", deciding
 * whether a filter is "set", and what "cleared" means — is arithmetic on that
 * array and belongs here so it is unit-testable without a component.
 *
 * Generic over the pool element rather than importing a `RandomizerCard` type
 * from `lib/api/types.ts`: that type is server-slice work landing in parallel
 * and may not exist yet. `{ recipeId: string }` is the only shape this module
 * needs — generic is the right call regardless of timing, since it keeps this
 * file usable by anything that can produce a pool of "things with a recipe
 * id" (tests included, with tiny literal fixtures instead of full cards).
 *
 * `lib/api/types.ts` also exports a type named `RandomizerFilters` — the
 * *request* contract `getRandomizerPool` accepts (every field optional, the
 * server re-clamps everything). This module's own filter shape below used to
 * share that name with a different meaning (client state, every field
 * required) — a real drift hazard, since "RandomizerFilters" then meant two
 * different shapes depending on which file you were reading. Route/UI plan
 * §"the wire types" renamed this one to {@link RandomizerFilterState} and
 * added {@link toPoolFilters} as the one place that converts between them, so
 * nothing else has to guess the mapping.
 */

import type { RandomizerFilters } from "#/lib/api/types";

/** The only shape a pool element must have for this module to operate on it. */
export interface DrawCandidate {
  recipeId: string;
}

/**
 * §5.1/§5.2/§5.3 in one function. A first draw and a re-roll are the same
 * operation — an independent uniform pick from the pool — with one
 * difference: a re-roll knows the previously-shown `recipeId` and must not
 * repeat it. So there is one entry point, not two:
 *
 * - First draw: call with `excludeRecipeId: null`.
 * - "Roll again": call with `excludeRecipeId` set to the current result's
 *   `recipeId`. That is the whole of §5.3's no-repeat rule — excluded unless
 *   excluding it would leave zero candidates, in which case the full pool is
 *   used again (pool size 1 ⇒ the same recipe comes back).
 *
 * §5.4 edge cases: an empty pool returns `{ status: "empty" }`, never throws.
 * A pool of exactly one candidate is drawable and comes back with
 * `onlyMatch: true` so the caller can annotate/disable "Roll again" ("That's
 * the only one that matches") instead of re-deriving pool size itself.
 *
 * `rng` defaults to `Math.random` and is injectable so tests can assert exact
 * selection instead of statistical shape — see {@link pickIndex}.
 */
export function draw<T extends DrawCandidate>(pool: readonly T[], excludeRecipeId: string | null, rng: () => number = Math.random): DrawResult<T> {
  if (pool.length === 0) return { status: "empty" };

  const candidates = excludeRecipeId === null ? pool : pool.filter((c) => c.recipeId !== excludeRecipeId);
  // §5.3: excluding the last result must never leave nothing to draw from.
  const effective = candidates.length > 0 ? candidates : pool;

  const card = effective[pickIndex(effective.length, rng)];
  return { status: "drawn", card, onlyMatch: pool.length === 1 };
}

export type DrawResult<T> = { status: "empty" } | { status: "drawn"; card: T; onlyMatch: boolean };

/**
 * Uniform index into a range of size `n`, `floor(rng() * n)`. `Math.random()`
 * only ever returns `[0, 1)`, so this is exact for the real generator — every
 * index 0…n-1 is reachable and rng()=0 always lands on index 0. Tests stub
 * `rng` with values that approach and even hit 1 (a hostile generator that
 * violates its own contract) to prove the clamp below, not just the formula:
 * without it, rng()=1 on a pool of n would compute index n, which is
 * out-of-bounds and would hand the caller `undefined` instead of a card.
 */
function pickIndex(n: number, rng: () => number): number {
  const i = Math.floor(rng() * n);
  if (i < 0) return 0;
  if (i >= n) return n - 1;
  return i;
}

/**
 * §5.6's staleness predicate — the only part of §5.6 that is logic rather
 * than presentation (the dice-tumble delay and the "mark it stale, don't
 * clear it" behavior are the component's job). A drawn recipe is stale when
 * it is no longer in the current (post-refetch) pool: filters changed under
 * it, or it fell out of scope. `recipeId: null` (nothing drawn yet) is never
 * stale. An empty pool makes any drawn recipe stale, same as any other pool
 * that no longer contains it — no special case needed.
 */
export function isResultStale<T extends DrawCandidate>(recipeId: string | null, pool: readonly T[]): boolean {
  if (recipeId === null) return false;
  return !pool.some((c) => c.recipeId === recipeId);
}

/**
 * §4.1's filter input, resolved: every field present (no `?`), so "what does
 * cleared look like" has exactly one answer instead of a mix of `undefined`
 * and empty values scattered across callers. `source` is modeled here too
 * (the pool query needs it) but is deliberately NOT one of the fields
 * {@link hasActiveFilters} / {@link countSheetFilters} / {@link clearFilters}
 * treat as "a filter" — §4.1 groups it under `// scope`, not alongside the
 * filter fields, and §4.5's "widen to corpus" is its own affordance with its
 * own "rolls immediately" behavior, never the "Clear filters" button. Clearing
 * filters must not silently un-widen someone back to their box mid-browse.
 *
 * Named `RandomizerFilterState` (not `RandomizerFilters`) to keep this
 * distinct from `lib/api/types.ts`'s `RandomizerFilters` — the wire request
 * contract, where every field is optional and absence means "unset", not
 * "cleared to this shape's defaults". {@link toPoolFilters} is the one
 * sanctioned conversion between the two.
 */
export interface RandomizerFilterState {
  source: "box" | "corpus";
  collectionId: string | null;
  favoritesOnly: boolean;
  cuisine: string | null;
  maxCookMinutes: number | null;
  includeUntimed: boolean;
  ingredient: string;
  mealType: string | null;
  diets: string[];
  avoidAllergens: string[];
  spiceLevel: string | null;
  skipRecentDays: number | null;
}

/**
 * §4.6/§6.3's skip-recent window, in days — the ONE place the number 14 lives.
 *
 * §6.3 pins the chip to a fixed window with no picker in v1, so the window is a
 * constant; but it was previously spelled three times (the default, the chip's
 * toggle-on value, the chip's label) plus a fourth time, in different units, in
 * the route's pool line ("the last 2 weeks"). That is how a screen ends up
 * saying "14 days" and "2 weeks" about one number, and how moving the constant
 * silently leaves a sentence lying. Everything that renders or sets the window
 * reads this.
 */
export const SKIP_RECENT_DAYS = 14;

/**
 * §5.5: the defaults are NOT all-empty. `skipRecentDays` defaults to 14 and
 * `includeUntimed` defaults to off — everything else defaults to "unset".
 * `source` defaults to "box" per §4.5. This is the one definition of
 * "default"; {@link clearFilters} and the initial filter state both read it
 * so the UI has no second place to (re)invent what "cleared" means.
 */
export function defaultFilters(): RandomizerFilterState {
  return {
    source: "box",
    collectionId: null,
    favoritesOnly: false,
    cuisine: null,
    maxCookMinutes: null,
    includeUntimed: false,
    ingredient: "",
    mealType: null,
    diets: [],
    avoidAllergens: [],
    spiceLevel: null,
    skipRecentDays: SKIP_RECENT_DAYS,
  };
}

/**
 * §5.5's "Clear filters" button. Everything resets to {@link defaultFilters},
 * except `source`, which is scope rather than a filter (see the
 * {@link RandomizerFilterState} doc) and survives the clear untouched.
 */
export function clearFilters(filters: RandomizerFilterState): RandomizerFilterState {
  return { ...defaultFilters(), source: filters.source };
}

/**
 * "Is any filter set?" — the inline "Clear filters" affordance needs to know
 * whether it has anything to do. Compares every field except `source` (see
 * the {@link RandomizerFilterState} doc) against {@link defaultFilters}.
 */
export function hasActiveFilters(filters: RandomizerFilterState): boolean {
  const d = defaultFilters();
  return (
    filters.collectionId !== d.collectionId ||
    filters.favoritesOnly !== d.favoritesOnly ||
    filters.cuisine !== d.cuisine ||
    filters.maxCookMinutes !== d.maxCookMinutes ||
    filters.includeUntimed !== d.includeUntimed ||
    filters.ingredient !== d.ingredient ||
    filters.mealType !== d.mealType ||
    filters.diets.length > 0 ||
    filters.avoidAllergens.length > 0 ||
    filters.spiceLevel !== d.spiceLevel ||
    filters.skipRecentDays !== d.skipRecentDays
  );
}

/**
 * §6.3's "More filters · N" badge count. The sheet holds exactly five
 * controls — diets, avoid-allergens, spice level, collection, include-untimed
 * — and N counts how many of those FIVE are set, not how many slugs are
 * picked inside a multi-select (two diets selected is still one control set).
 */
export function countSheetFilters(filters: RandomizerFilterState): number {
  let n = 0;
  if (filters.diets.length > 0) n++;
  if (filters.avoidAllergens.length > 0) n++;
  if (filters.spiceLevel !== null) n++;
  if (filters.collectionId !== null) n++;
  if (filters.includeUntimed) n++;
  return n;
}

/**
 * The one sanctioned conversion from client filter state to the server's
 * request shape (`lib/api/types.ts`'s `RandomizerFilters`, imported
 * type-only — this module stays free of any non-type import from the wire
 * layer). Every `null`/empty field becomes `undefined` ("unset"), **except**
 * `skipRecentDays`, whose own `null` already means "off" on both sides (§4.1:
 * "`undefined` ⇒ the default (14); `null` ⇒ off") — passed straight through
 * unchanged, never coerced to `undefined`.
 *
 * A pure, unit-tested mapping so nothing else in the UI has to reinvent "what
 * does an unset chip look like on the wire" — the pool query, the route
 * loader's `ensureQueryData` and every refetch all call this on the same
 * `RandomizerFilterState` and get the same request shape back.
 */
export function toPoolFilters(state: RandomizerFilterState): RandomizerFilters {
  return {
    source: state.source,
    collectionId: state.collectionId ?? undefined,
    favoritesOnly: state.favoritesOnly,
    cuisine: state.cuisine ?? undefined,
    maxCookMinutes: state.maxCookMinutes ?? undefined,
    includeUntimed: state.includeUntimed,
    ingredient: state.ingredient.trim() === "" ? undefined : state.ingredient,
    mealType: state.mealType ?? undefined,
    diets: state.diets,
    avoidAllergens: state.avoidAllergens,
    spiceLevel: state.spiceLevel ?? undefined,
    skipRecentDays: state.skipRecentDays,
  };
}
