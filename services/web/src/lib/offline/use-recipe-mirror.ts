/**
 * The mini-mirror (offline plan §4.6).
 *
 * Lazy caching fails the actual use case. A phone that has only ever *opened*
 * three recipes has only those three offline, and the moment offline matters is
 * standing in a store wanting the fourth. The box **list** is a single server
 * function returning the whole box, so it is offline-free the moment the
 * persister has seen it once; the **details** are one request each and need
 * fetching ahead of time.
 *
 * This is the ~50-line version M1 ships. It is silent and best-effort: its only
 * user-visible behaviour is that offline recipe details simply work. The
 * observable progress store, the "Syncing 47 of 312" chip, `saveData` detection
 * and the retry affordance are all M3 (§6.4) — deliberately, because a progress
 * UI is a promise that the work will finish, and this version does not make one.
 *
 * The pausing rules are what keep it from being a nuisance:
 *
 * - **Hidden document** — nothing to prefetch for; the phone is in a pocket.
 * - **Offline** — every request would fail, and three failures park the run.
 * - **Cook mode / a running timer** — a 90-minute bake on a counter is the one
 *   time the main thread's spare cycles are not spare. `document.hidden` does not
 *   cover it: cook mode is a fullscreen overlay on a visible page.
 *
 * Concurrency 2, scheduled in `requestIdleCallback`. Safari has no
 * `requestIdleCallback`, so a `setTimeout` fallback stands in — it does not
 * measure idleness, but it does yield, which is the part that matters.
 */

import { useEffect, useRef } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { householdRecipeQuery, keys, type HouseholdRecipeRow } from "#/lib/api";

/** Two at a time: enough to make progress, few enough to stay out of the way. */
const CONCURRENCY = 2;

/** Consecutive failures that park the run until the next app open. */
const FAILURE_BUDGET = 3;

/** How long a mirrored detail counts as "already have it" — the persister's own maxAge. */
const FRESH_MS = 1000 * 60 * 60 * 24 * 14;

/**
 * A scheduled continuation. Two kinds, tracked apart because they cancel
 * differently: idle callbacks (the work) and timeouts (the "not now, try again
 * shortly" path). Cancelling one with the other's API is a silent no-op that
 * leaves the mirror running after the route unmounts.
 */
type Scheduled = { kind: "idle"; id: number } | { kind: "timeout"; id: ReturnType<typeof setTimeout> };

/** `requestIdleCallback` where it exists; Safari has never shipped it. The
 * fallback does not measure idleness, but it does yield, which is the part that
 * keeps a 300-recipe walk off the main thread's critical path. */
function onIdle(run: () => void): Scheduled {
  if (typeof requestIdleCallback === "function") return { kind: "idle", id: requestIdleCallback(() => run(), { timeout: 2000 }) };
  return { kind: "timeout", id: setTimeout(run, 250) };
}

function cancel(scheduled: Scheduled | null): void {
  if (!scheduled) return;
  if (scheduled.kind === "idle" && typeof cancelIdleCallback === "function") cancelIdleCallback(scheduled.id);
  else if (scheduled.kind === "timeout") clearTimeout(scheduled.id);
}

/**
 * Is now a bad time? Read fresh on every batch rather than subscribed to,
 * because the mirror only needs the answer at the two-recipe granularity it
 * works at, and a subscription would mean re-running the whole effect on every
 * visibility flip.
 */
function shouldPause(cooking: boolean): boolean {
  if (typeof document !== "undefined" && document.hidden) return true;
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  // Cook mode is a fullscreen overlay on a visible page, so `document.hidden`
  // does not cover it. `?cook` is the deep link into the apron; the planner
  // opens it without a URL change, which this deliberately does not chase —
  // a mirror that keeps running under a timer is a nuisance, not a bug, and
  // M3's progress store is where that gets a proper signal (§6.4).
  return cooking;
}

/**
 * Walk one household's box, prefetching the details that are missing or stale.
 * Returns the canceller. A plain function rather than effect-body closures, so
 * `householdId` is a `string` here instead of something narrowed three scopes up.
 */
function startMirror(queryClient: QueryClient, householdId: string, recipeIds: string[], isCooking: () => boolean): () => void {
  let cancelled = false;
  let scheduled: Scheduled | null = null;
  let failures = 0;

  const queue = recipeIds.filter((recipeId) => {
    const state = queryClient.getQueryState(keys.household.recipe(householdId, recipeId));
    return !state?.dataUpdatedAt || Date.now() - state.dataUpdatedAt > FRESH_MS;
  });

  function pump(): void {
    if (cancelled || queue.length === 0 || failures >= FAILURE_BUDGET) return;

    scheduled = onIdle(() => {
      if (cancelled) return;
      if (shouldPause(isCooking())) {
        // Not a failure — just not now.
        scheduled = { kind: "timeout", id: setTimeout(pump, 5_000) };
        return;
      }

      const batch = queue.splice(0, CONCURRENCY);
      void Promise.all(batch.map((recipeId) => queryClient.prefetchQuery(householdRecipeQuery(householdId, recipeId)))).then(() => {
        if (cancelled) return;
        // `prefetchQuery` never rejects — it swallows the error into the query
        // state — so a resolved promise proves nothing. An entry that still has
        // no `dataUpdatedAt` after a prefetch is the real failure signal.
        const landed = batch.filter((recipeId) => queryClient.getQueryState(keys.household.recipe(householdId, recipeId))?.dataUpdatedAt);
        failures = landed.length > 0 ? 0 : failures + 1;
        pump();
      });
    });
  }

  pump();

  return () => {
    cancelled = true;
    cancel(scheduled);
  };
}

/**
 * Prefetch every box recipe's detail that is not already cached and fresh.
 *
 * Takes the rows rather than reading the box query itself, so it runs off the
 * same payload the ledger is rendering — no second subscription, and no chance
 * of mirroring a list the user is not looking at.
 */
export function useRecipeMirror(householdId: string | null, recipes: HouseholdRecipeRow[]): void {
  const queryClient = useRouter().options.context.queryClient;
  // Selected, not read off `router.state` inside the walk: a subscription keeps
  // the flag current without the mirror reaching into router internals, and the
  // selector means a re-render only when this one boolean flips.
  const cooking = useRouterState({ select: (state) => state.location.searchStr.includes("cook") });
  // The row *ids* are what the mirror cares about; re-running because a title
  // changed would restart the walk for nothing.
  const ids = recipes.map((row) => row.recipeId).join(",");
  // Through a ref, so entering or leaving cook mode does not re-run the effect:
  // restarting the walk on every toggle would throw away the queue's progress.
  // Written in an effect rather than during render — a ref assigned inline is a
  // render-phase side effect, which the React Compiler rules reject outright.
  const cookingRef = useRef(cooking);
  useEffect(() => {
    cookingRef.current = cooking;
  }, [cooking]);

  useEffect(() => {
    if (!householdId || ids === "") return;
    return startMirror(queryClient, householdId, ids.split(","), () => cookingRef.current);
  }, [householdId, ids, queryClient]);
}
