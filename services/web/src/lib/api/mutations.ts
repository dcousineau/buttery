/**
 * The write side of the port (§4.1).
 *
 * **M1 writes are online-only, deliberately.** They run through the transport
 * and invalidate a query key prefix; they do not get `networkMode:
 * "offlineFirst"`, they are not persisted, and while the browser is offline the
 * affordances that trigger them are disabled (`useIsOnline`). Queuing a write is
 * M2's job, and M2 is gated on a property M1 cannot assume: that every offline
 * write is replay-safe *by shape* (§2.5). `toggleHouseholdRecipeFavorite` is the
 * counter-example sitting in this file right now — it is a server-side toggle,
 * so replaying it twice flips twice.
 *
 * What M1 does establish is the shape M2 slots into: every write is a
 * `mutationOptions` object with a `mutationKey`, an optimistic `onMutate` that
 * patches the query cache, an `onError` that puts the snapshot back, and an
 * `onSettled` that invalidates. That is the same lifecycle a persisted mutation
 * replays through, so M2 adds `setMutationDefaults` against these same keys and
 * changes nothing else here.
 *
 * The optimistic patch functions themselves are NOT here: they live beside the
 * feature (`components/plan/optimistic.ts`, `components/grocery/optimistic.ts`),
 * are pure, and are unit-tested. This file wires them to the cache.
 */

import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { withAllCleared, withCheckedCleared, withItemChecked, withItemEdited, withItemRemoved } from "#/components/grocery/optimistic";
import { withEntriesAppended, withEntryCooked, withEntryMoved, withEntryRemoved, withNoteBody } from "#/components/plan/optimistic";
import type { MealSlot, PlanDate } from "#/lib/plan/week";
import { keys } from "./keys";
import * as api from "./transport";
import type { GroceryListPayload, PlanEntry, PlanWeek } from "./types";

/**
 * Mutation keys. Flat strings, one per write, because M2 registers
 * `setMutationDefaults` against them at client boot and a dehydrated mutation
 * carries only its key — the function does not serialize. Renaming one after M2
 * ships orphans whatever is already queued in someone's IndexedDB, so treat
 * these as a wire contract from now, not from M2.
 */
export const mutationKeys = {
  groceryItemChecked: ["grocery-item-checked"] as const,
  groceryItemEdited: ["grocery-item-edited"] as const,
  groceryItemRemoved: ["grocery-item-removed"] as const,
  grocerySweep: ["grocery-sweep"] as const,
  planEntryMoved: ["plan-entry-moved"] as const,
  planEntryRemoved: ["plan-entry-removed"] as const,
  planEntryCooked: ["plan-entry-cooked"] as const,
  planEntriesAdded: ["plan-entries-added"] as const,
  planNoteSaved: ["plan-note-saved"] as const,
  recipeFavorite: ["recipe-favorite"] as const,
} as const;

/**
 * The optimistic-write lifecycle, once, for one query key.
 *
 * Cancel in-flight refetches (or one lands mid-write and overwrites the patch),
 * snapshot, patch, restore the snapshot on failure, invalidate when it settles
 * either way. This is the `useOptimistic` + `router.invalidate()` dance the plan
 * and grocery routes each hand-rolled, minus the flicker problem both of them
 * carry long comments about: Query holds the patched value in the cache rather
 * than in a transition, so there is no window where the settled payload and the
 * dropped patch disagree.
 *
 * `onSettled` invalidates on success *and* failure. After a failed write the
 * client does not know whether it half-happened, and the server is the only
 * thing that does.
 */
function optimisticOver<TData, TVars, TResult>(queryClient: QueryClient, queryKey: readonly unknown[], patch: (current: TData, vars: TVars) => TData) {
  return {
    onMutate: async (vars: TVars) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<TData>(queryKey);
      if (previous !== undefined) queryClient.setQueryData<TData>(queryKey, patch(previous, vars));
      return { previous };
    },
    onError: (_error: unknown, _vars: TVars, context: { previous?: TData } | undefined) => {
      if (context?.previous !== undefined) queryClient.setQueryData<TData>(queryKey, context.previous);
    },
    onSettled: (_data: TResult | undefined, _error: unknown, _vars: TVars) => queryClient.invalidateQueries({ queryKey }),
  };
}

// --- the grocery list ---------------------------------------------------

export function toggleGroceryItemMutation(queryClient: QueryClient, householdId: string) {
  const queryKey = keys.household.grocery(householdId);
  return mutationOptions({
    mutationKey: mutationKeys.groceryItemChecked,
    mutationFn: (vars: { itemId: string; checked: boolean }) => api.toggleGroceryItem(vars),
    ...optimisticOver<GroceryListPayload, { itemId: string; checked: boolean }, { checkedAt: string | null }>(queryClient, queryKey, (list, vars) =>
      withItemChecked(list, vars.itemId, vars.checked),
    ),
  });
}

export function updateGroceryItemMutation(queryClient: QueryClient, householdId: string) {
  const queryKey = keys.household.grocery(householdId);
  type Vars = { itemId: string; displayName?: string; quantity?: number | null };
  return mutationOptions({
    mutationKey: mutationKeys.groceryItemEdited,
    mutationFn: (vars: Vars) => api.updateGroceryItem(vars),
    ...optimisticOver<GroceryListPayload, Vars, { updated: boolean }>(queryClient, queryKey, (list, vars) =>
      withItemEdited(list, vars.itemId, { displayName: vars.displayName, quantity: vars.quantity }),
    ),
  });
}

export function removeGroceryItemMutation(queryClient: QueryClient, householdId: string) {
  const queryKey = keys.household.grocery(householdId);
  return mutationOptions({
    mutationKey: mutationKeys.groceryItemRemoved,
    mutationFn: (vars: { itemId: string }) => api.removeGroceryItem(vars.itemId),
    ...optimisticOver<GroceryListPayload, { itemId: string }, { removed: boolean }>(queryClient, queryKey, (list, vars) => withItemRemoved(list, vars.itemId)),
  });
}

/**
 * The three list-wide sweeps behind one mutation, discriminated by `kind`.
 *
 * One key rather than three because they are the same gesture with different
 * blast radii, and because M2 explicitly refuses to take any of them offline
 * (§5.2): the row set a sweep touches *grows* between queue-time and replay, so
 * a sweep queued on Saturday and replayed on Sunday clears rows the user never
 * saw. Keeping them together keeps that exclusion to one line.
 */
export function grocerySweepMutation(queryClient: QueryClient, householdId: string) {
  const queryKey = keys.household.grocery(householdId);
  type Vars = { kind: "purchased" | "all" | "delete" };
  return mutationOptions({
    mutationKey: mutationKeys.grocerySweep,
    mutationFn: (vars: Vars) => {
      if (vars.kind === "purchased") return api.clearPurchasedGroceryItems();
      if (vars.kind === "all") return api.clearAllGroceryItems();
      return api.deleteAllGroceryItems();
    },
    ...optimisticOver<GroceryListPayload, Vars, { cleared: number } | { removed: number }>(queryClient, queryKey, (list, vars) =>
      vars.kind === "purchased" ? withCheckedCleared(list) : withAllCleared(list),
    ),
  });
}

// --- the meal plan ------------------------------------------------------

export function moveMealPlanEntryMutation(queryClient: QueryClient, householdId: string, week: PlanDate | undefined) {
  const queryKey = keys.household.plan(householdId, week);
  type Vars = { entryId: string; toDate: PlanDate; toSlot: MealSlot };
  return mutationOptions({
    mutationKey: mutationKeys.planEntryMoved,
    mutationFn: (vars: Vars) => api.moveMealPlanEntry(vars),
    ...optimisticOver<PlanWeek, Vars, { moved: boolean }>(queryClient, queryKey, (current, vars) => withEntryMoved(current, vars.entryId, vars.toDate, vars.toSlot)),
  });
}

export function removeMealPlanEntryMutation(queryClient: QueryClient, householdId: string, week: PlanDate | undefined) {
  const queryKey = keys.household.plan(householdId, week);
  return mutationOptions({
    mutationKey: mutationKeys.planEntryRemoved,
    mutationFn: (vars: { entryId: string }) => api.removeMealPlanEntry(vars.entryId),
    ...optimisticOver<PlanWeek, { entryId: string }, { removed: boolean }>(queryClient, queryKey, (current, vars) => withEntryRemoved(current, vars.entryId)),
  });
}

export function setMealPlanEntryCookedMutation(queryClient: QueryClient, householdId: string, week: PlanDate | undefined) {
  const queryKey = keys.household.plan(householdId, week);
  type Vars = { entryId: string; cooked: boolean };
  return mutationOptions({
    mutationKey: mutationKeys.planEntryCooked,
    mutationFn: (vars: Vars) => api.setMealPlanEntryCooked(vars),
    ...optimisticOver<PlanWeek, Vars, { cookedAt: string | null }>(queryClient, queryKey, (current, vars) => withEntryCooked(current, vars.entryId, vars.cooked)),
  });
}

/**
 * Adding recipes to a slot. The optimistic entries are built by the caller (it
 * has the ledger rows; this module has only ids), so `vars` carries the patch
 * payload rather than the raw rows.
 */
export function addMealPlanRecipesMutation(queryClient: QueryClient, householdId: string, week: PlanDate | undefined) {
  const queryKey = keys.household.plan(householdId, week);
  type Vars = { date: PlanDate; slot: MealSlot; recipeIds: string[]; optimisticEntries: PlanEntry[] };
  return mutationOptions({
    mutationKey: mutationKeys.planEntriesAdded,
    mutationFn: (vars: Vars) => api.addMealPlanRecipes({ date: vars.date, slot: vars.slot, recipeIds: vars.recipeIds }),
    ...optimisticOver<PlanWeek, Vars, unknown>(queryClient, queryKey, (current, vars) => withEntriesAppended(current, vars.date, vars.slot, vars.optimisticEntries)),
  });
}

/**
 * Create-or-edit a plan note. One mutation for both because the write is
 * "this slot's note now reads X" either way; `entryId` present means edit.
 */
export function saveMealPlanNoteMutation(queryClient: QueryClient, householdId: string, week: PlanDate | undefined) {
  const queryKey = keys.household.plan(householdId, week);
  type Vars = { entryId?: string; date: PlanDate; slot: MealSlot; body: string; optimisticEntry?: PlanEntry };
  return mutationOptions({
    mutationKey: mutationKeys.planNoteSaved,
    mutationFn: (vars: Vars) =>
      vars.entryId ? api.updateMealPlanNote({ entryId: vars.entryId, body: vars.body }) : api.addMealPlanNote({ date: vars.date, slot: vars.slot, body: vars.body }),
    ...optimisticOver<PlanWeek, Vars, unknown>(queryClient, queryKey, (current, vars) =>
      vars.entryId ? withNoteBody(current, vars.entryId, vars.body) : vars.optimisticEntry ? withEntriesAppended(current, vars.date, vars.slot, [vars.optimisticEntry]) : current,
    ),
  });
}

// --- the recipe box -----------------------------------------------------

/**
 * Favourite/unfavourite. Patches **two** cache entries — the detail the star
 * lives on and the ledger row beside it — because they are separate queries over
 * the same fact, and a star that reverts in the list a second after it lit up in
 * the pane is exactly the "did my tap take?" flicker this design exists to kill.
 *
 * Online-only for M1 and M2 alike as written: the server owns the flip, so the
 * client cannot state an absolute intent. §5.2 replaces it with
 * `setHouseholdRecipeFavorite({ recipeId, favorite })`, at which point it
 * becomes replay-safe and can queue.
 */
export function toggleRecipeFavoriteMutation(queryClient: QueryClient, householdId: string) {
  type Vars = { recipeId: string; favorite: boolean };
  return mutationOptions({
    mutationKey: mutationKeys.recipeFavorite,
    mutationFn: (vars: Vars) => api.toggleHouseholdRecipeFavorite(vars.recipeId),
    onSettled: async (_data: unknown, _error: unknown, vars: Vars) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.household.recipe(householdId, vars.recipeId) }),
        queryClient.invalidateQueries({ queryKey: keys.household.recipes(householdId) }),
      ]);
    },
  });
}
