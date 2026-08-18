/**
 * The `queryOptions` factories — the offline boundary, written down (§4.1).
 *
 * **A route is offline-capable if and only if its data comes from a factory in
 * this file.** There is no third state. A route reading through a plain loader
 * is online-only, and that is fine until it crosses the boundary; a route
 * reading through a factory gets the persister, refetch-on-reconnect, prefix
 * invalidation and the mini-mirror, all of them, together.
 *
 * Every factory takes `householdId` as its first argument and puts it in the key
 * only (§2.4). The server never sees it: it reads the active household from the
 * session. The client needs it so that switching households cannot serve one
 * household's rows to another — a privacy failure, not a cache miss.
 *
 * `useSuspenseQuery(...)` in the component, `ensureQueryData(...)` in the loader,
 * both handed the *same* factory call. That pairing is what makes SSR stream and
 * the client hydrate off one cache entry instead of two.
 */

import { queryOptions } from "@tanstack/react-query";
import type { PlanDate } from "#/lib/plan/week";
import { keys } from "./keys";
import * as api from "./transport";

/**
 * A recipe box changes when someone in the household adds to it, which is rare
 * on the scale of a shopping trip — but the list is also the mirror's work queue
 * (§4.6), so it is the one read worth keeping warm.
 */
export function householdRecipesQuery(householdId: string) {
  return queryOptions({
    queryKey: keys.household.recipes(householdId),
    queryFn: () => api.listHouseholdRecipes(),
  });
}

/**
 * One recipe's full detail. `null` is a real, cacheable answer here ("not in
 * your box"), not an error — the detail route renders a specific empty state
 * for it, and caching it stops the mirror from re-requesting a recipe that was
 * removed from the box while it was walking the list.
 */
export function householdRecipeQuery(householdId: string, recipeId: string) {
  return queryOptions({
    queryKey: keys.household.recipe(householdId, recipeId),
    queryFn: () => api.getHouseholdRecipe(recipeId),
  });
}

/**
 * A plan week. `week` is `undefined` for "whatever the server calls this week",
 * which is a distinct cache entry from any dated one — the server resolves it
 * against the household's timezone and week-start day, so the client cannot
 * compute the equivalent date without duplicating that logic. The key spells it
 * `"current"` rather than leaving a hole in the tuple.
 */
export function mealPlanWeekQuery(householdId: string, week: PlanDate | undefined) {
  return queryOptions({
    queryKey: keys.household.plan(householdId, week),
    queryFn: () => api.getMealPlanWeek(week),
  });
}

/**
 * The shopping list. The single best offline read in the app: it is looked at in
 * a store, on a phone, on the one network the household does not control.
 *
 * A shorter `staleTime` than the client default, because the list is the surface
 * two people touch simultaneously (grocery plan D12) and a stale row here is a
 * duplicate purchase rather than a cosmetic lag.
 */
export function groceryListQuery(householdId: string) {
  return queryOptions({
    queryKey: keys.household.grocery(householdId),
    queryFn: () => api.getGroceryList(),
    staleTime: 10_000,
  });
}

/**
 * The keys for the un-migrated resources (`me.households`, `household.members`,
 * `household.preferences`, the public browse surface) are reserved in `keys.ts`
 * but have no factory yet, on purpose: a factory here is a promise that the
 * resource is offline-capable, and those routes still read through plain
 * loaders (§4.1). They get their factory on the day they cross the boundary.
 */
