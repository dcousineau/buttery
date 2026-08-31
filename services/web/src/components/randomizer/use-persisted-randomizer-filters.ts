/**
 * Change 2 of the post-ship follow-ups: the randomizer's filter state,
 * persisted to `localStorage` per household so it survives a navigation away
 * and back — instead of silently resetting to `defaultFilters()` on every
 * visit the way it did at ship time.
 *
 * This is the component half of the persistence story; `lib/randomizer/
 * persist.ts` is the pure half (serialize/parse/merge, no `localStorage`
 * access of its own). This module owns the ONLY two `window.localStorage`
 * calls in the whole feature, both wrapped in try/catch — Safari private
 * mode and a "block all site data" setting can throw on ACCESS, not just on
 * write, so a bare `localStorage.getItem` here would crash the route for
 * exactly the households most likely to have that setting on.
 *
 * **The SSR/hydration hazard this is built around:** `/household/randomizer`
 * is server-rendered, and there is no `localStorage` on the server. Reading
 * it during the initial render — or even during the FIRST client render,
 * before hydration has reconciled against the server-rendered markup — would
 * make the server's HTML and the client's first paint disagree, which React
 * reports as a hydration mismatch. So the state here always STARTS at
 * `defaultFilters()` (same value the server rendered, same value the
 * route's `loader` primed the pool query with), and the stored value, if
 * any, is only applied once hydration has actually completed.
 *
 * **How "once hydration has completed" is detected without an effect that
 * calls `setState`.** `useHydrated()` (`lib/hooks/use-hydrated.ts`) is the
 * repo's sanctioned `useSyncExternalStore` idiom for exactly this — see its
 * own doc comment, and `lib/hooks/use-mobile.ts` / `components/plan/
 * ThisWeekPanel.tsx`'s `useHydrated` for the established precedent ("keeps
 * this off the `react-hooks/set-state-in-effect` path"). Once `hydrated` is
 * `true`, the restore itself is applied through React's own documented
 * "adjust state while rendering" pattern
 * (react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
 * — comparing `restoredFor` against `householdId` DURING render and calling
 * both setters right there, not inside a `useEffect` — so the restore lands
 * in the very next render pass with no extra committed frame showing stale
 * defaults, and no `setState`-in-`useEffect` for the linter to (rightly)
 * question.
 *
 * **The clobber hazard that still has to be guarded against:** the write-back
 * effect (the one real side effect here — writing to `localStorage` is
 * exactly what effects are for) must not fire with the pre-restore defaults
 * and stamp them over a household's real stored filters before the restore
 * above has actually happened. It reads the SAME `restoredFor === householdId`
 * comparison to gate that.
 */

import { useEffect, useState } from "react";
import { useHydrated } from "#/lib/hooks/use-hydrated";
import { defaultFilters, type RandomizerFilterState } from "#/lib/randomizer/draw";
import { randomizerFiltersStorageKey, restoreFilters, serializeFilters } from "#/lib/randomizer/persist";

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Safari private mode (and a "block site data" setting) can throw on
    // ACCESS, not only on write. A read that fails is indistinguishable from
    // "nothing stored yet" — `restoreFilters(null)` already answers that
    // correctly with the plain defaults.
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Quota exceeded, private mode, or storage blocked outright. Persistence
    // is a per-viewer convenience, not a guarantee — failing silently here
    // just means next visit starts at the defaults again, same as today.
  }
}

/**
 * Owns the randomizer's `RandomizerFilterState`, backed by `localStorage`.
 * Drop-in for the `useState<RandomizerFilterState>(defaultFilters)` the
 * route used before persistence existed — same `[value, setValue]` shape —
 * so the route's own `onChangeFilters`/`onClearFilters`/`setFilters` call
 * sites needed no changes beyond the one import.
 *
 * - **Restore** happens during render, once `hydrated` flips true and
 *   `restoredFor` (which household the CURRENT `filters` value was restored
 *   for) no longer matches `householdId` — covering both the first mount and
 *   a later household switch with the same check. Calling `setFilters` and
 *   `setRestoredFor` together, right here rather than inside a `useEffect`,
 *   is React's own documented pattern for adjusting state during render
 *   without an extra committed (flashed) frame — see the module doc comment.
 *   The `readStored` call this performs is a synchronous, side-effect-free
 *   read of an external source, which is what makes doing it during render
 *   safe: nothing here is written until the effect below.
 * - **Write-back** is a genuine `useEffect` — writing to `localStorage` is
 *   the one real side effect in this hook — gated on that SAME `restoredFor
 *   === householdId` comparison, so it cannot fire with the pre-restore
 *   `defaultFilters()` and clobber a household's real stored filters before
 *   the restore above has actually run for this household.
 */
export function usePersistedRandomizerFilters(householdId: string): [RandomizerFilterState, React.Dispatch<React.SetStateAction<RandomizerFilterState>>] {
  const hydrated = useHydrated();
  const [filters, setFilters] = useState<RandomizerFilterState>(defaultFilters);
  const [restoredFor, setRestoredFor] = useState<string | null>(null);

  // Render-phase restore (react.dev/learn/you-might-not-need-an-effect
  // #adjusting-some-state-when-a-prop-changes) — not a `useEffect`, so there
  // is nothing here for `react-hooks/set-state-in-effect` to flag. Bails out
  // immediately on the render right after these setters run, because that
  // render sees `restoredFor === householdId` and skips this whole branch.
  if (hydrated && restoredFor !== householdId) {
    setRestoredFor(householdId);
    setFilters(restoreFilters(readStored(randomizerFiltersStorageKey(householdId))));
  }

  useEffect(() => {
    if (restoredFor !== householdId) return;
    writeStored(randomizerFiltersStorageKey(householdId), serializeFilters(filters));
  }, [filters, restoredFor, householdId]);

  return [filters, setFilters];
}
