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

import { hashKey, mutationOptions, type QueryClient } from "@tanstack/react-query";
import { withAllCleared, withCheckedCleared, withItemChecked, withItemEdited, withItemRemoved } from "#/components/grocery/optimistic";
import { withEntriesAppended, withEntryCooked, withEntryMoved, withEntryRemoved, withNoteBody } from "#/components/plan/optimistic";
import type { MealSlot, PlanDate } from "#/lib/plan/week";
import { keys } from "./keys";
import * as api from "./transport";
import type { GroceryListPayload, HouseholdRecipeDetail, HouseholdRecipeRow, PlanEntry, PlanWeek } from "./types";

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
 * The tag every mutation in this file carries so it can recognise its siblings.
 *
 * `queryClient.isMutating()` can filter by mutation key, but "which writes are
 * in flight over *this cache entry*" is a different question. Three different
 * mutation keys (`grocery-item-checked`, `-edited`, `-removed`) all patch the
 * one grocery payload, and favouriting recipe A patches the same ledger entry
 * that favouriting recipe B does — so a mutation-key filter would miss exactly
 * the collisions that matter. The shared cache entry is therefore stamped on the
 * mutation itself, and counted with a predicate over that stamp.
 */
interface CacheScopeMeta {
  cacheScope?: string;
}

/**
 * "Am I the last write still in flight over this cache entry?"
 *
 * The guard every optimistic write needs and neither of the hand-rolled
 * versions this file replaced had. Without it, two overlapping writes on one key
 * fight each other in both directions:
 *
 * - `onSettled` invalidating unconditionally means the *first* write to settle
 *   triggers a refetch, and that refetch returns server state that does not yet
 *   include the second write — so the second write's optimistic patch is wiped
 *   and reappears a round trip later. Tick "milk", then "eggs": eggs visibly
 *   un-ticks, then re-ticks. That is precisely the flicker this module's header
 *   claims Query removes.
 * - `onError` restoring its snapshot means a write that fails puts back a
 *   payload captured *before* a later, still-pending write patched the same key,
 *   silently dropping that one's patch too.
 *
 * Both are answered by deferring to the last writer: whoever settles last
 * invalidates (so the server reconciles everything at once), and only the last
 * writer rolls back (so a rollback cannot un-patch someone else's write; the
 * invalidation that follows is what corrects the failed one).
 *
 * `=== 1` rather than `=== 0` because the mutation running this callback is
 * still `pending` — query-core dispatches `success`/`error` *after* awaiting
 * `onSettled`. So one means "only me".
 */
function cacheScope(queryClient: QueryClient, queryKey: readonly unknown[]) {
  const scope = hashKey(queryKey);
  return {
    meta: { cacheScope: scope } satisfies CacheScopeMeta,
    isLastWrite: () => queryClient.isMutating({ predicate: (mutation) => (mutation.meta as CacheScopeMeta | undefined)?.cacheScope === scope }) === 1,
  };
}

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
 * thing that does. Both it and the rollback defer to {@link cacheScope} so that
 * overlapping writes on one key do not undo each other.
 *
 * `invalidateKey` defaults to the patched key and differs only where one
 * resource is addressable under more than one key — the plan, whose current week
 * lives under both `"current"` and its date (`keys.household.planAll`). The
 * patch stays exact; the invalidation goes wide.
 */
function optimisticOver<TData, TVars, TResult>(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  patch: (current: TData, vars: TVars) => TData,
  invalidateKey: readonly unknown[] = queryKey,
) {
  const scope = cacheScope(queryClient, queryKey);
  return {
    meta: scope.meta,
    onMutate: async (vars: TVars) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<TData>(queryKey);
      if (previous !== undefined) queryClient.setQueryData<TData>(queryKey, patch(previous, vars));
      return { previous };
    },
    onError: (_error: unknown, _vars: TVars, context: { previous?: TData } | undefined) => {
      if (context?.previous !== undefined && scope.isLastWrite()) queryClient.setQueryData<TData>(queryKey, context.previous);
    },
    onSettled: (_data: TResult | undefined, _error: unknown, _vars: TVars) => (scope.isLastWrite() ? queryClient.invalidateQueries({ queryKey: invalidateKey }) : undefined),
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

/**
 * Every plan write patches the exact week it was made on and invalidates the
 * *whole* plan prefix.
 *
 * The asymmetry is forced by the key namespace: `undefined` ("this week") and
 * the date the server resolves it to are two entries over identical data, and
 * only the server can tell they are the same week (`keys.household.planAll`
 * carries the long version). Invalidating just the key a write was built with
 * leaves the other spelling holding pre-write data — delete a meal under
 * `?week=X`, click "Today", and inside `staleTime` the meal is back on screen.
 *
 * A move can also land on a week that is not the one on screen, which the same
 * prefix covers for free. The cost is that the other cached weeks are marked
 * stale; they are inactive, so nothing refetches until one is looked at again.
 */
function planKeys(householdId: string, week: PlanDate | undefined) {
  return { queryKey: keys.household.plan(householdId, week), invalidateKey: keys.household.planAll(householdId) };
}

export function moveMealPlanEntryMutation(queryClient: QueryClient, householdId: string, week: PlanDate | undefined) {
  const { queryKey, invalidateKey } = planKeys(householdId, week);
  type Vars = { entryId: string; toDate: PlanDate; toSlot: MealSlot };
  return mutationOptions({
    mutationKey: mutationKeys.planEntryMoved,
    mutationFn: (vars: Vars) => api.moveMealPlanEntry(vars),
    ...optimisticOver<PlanWeek, Vars, { moved: boolean }>(queryClient, queryKey, (current, vars) => withEntryMoved(current, vars.entryId, vars.toDate, vars.toSlot), invalidateKey),
  });
}

export function removeMealPlanEntryMutation(queryClient: QueryClient, householdId: string, week: PlanDate | undefined) {
  const { queryKey, invalidateKey } = planKeys(householdId, week);
  return mutationOptions({
    mutationKey: mutationKeys.planEntryRemoved,
    mutationFn: (vars: { entryId: string }) => api.removeMealPlanEntry(vars.entryId),
    ...optimisticOver<PlanWeek, { entryId: string }, { removed: boolean }>(queryClient, queryKey, (current, vars) => withEntryRemoved(current, vars.entryId), invalidateKey),
  });
}

export function setMealPlanEntryCookedMutation(queryClient: QueryClient, householdId: string, week: PlanDate | undefined) {
  const { queryKey, invalidateKey } = planKeys(householdId, week);
  type Vars = { entryId: string; cooked: boolean };
  return mutationOptions({
    mutationKey: mutationKeys.planEntryCooked,
    mutationFn: (vars: Vars) => api.setMealPlanEntryCooked(vars),
    ...optimisticOver<PlanWeek, Vars, { cookedAt: string | null }>(queryClient, queryKey, (current, vars) => withEntryCooked(current, vars.entryId, vars.cooked), invalidateKey),
  });
}

/**
 * Adding recipes to a slot. The optimistic entries are built by the caller (it
 * has the ledger rows; this module has only ids), so `vars` carries the patch
 * payload rather than the raw rows.
 */
export function addMealPlanRecipesMutation(queryClient: QueryClient, householdId: string, week: PlanDate | undefined) {
  const { queryKey, invalidateKey } = planKeys(householdId, week);
  type Vars = { date: PlanDate; slot: MealSlot; recipeIds: string[]; optimisticEntries: PlanEntry[] };
  return mutationOptions({
    mutationKey: mutationKeys.planEntriesAdded,
    mutationFn: (vars: Vars) => api.addMealPlanRecipes({ date: vars.date, slot: vars.slot, recipeIds: vars.recipeIds }),
    ...optimisticOver<PlanWeek, Vars, unknown>(queryClient, queryKey, (current, vars) => withEntriesAppended(current, vars.date, vars.slot, vars.optimisticEntries), invalidateKey),
  });
}

/**
 * Create-or-edit a plan note. One mutation for both because the write is
 * "this slot's note now reads X" either way; `entryId` present means edit.
 */
export function saveMealPlanNoteMutation(queryClient: QueryClient, householdId: string, week: PlanDate | undefined) {
  const { queryKey, invalidateKey } = planKeys(householdId, week);
  type Vars = { entryId?: string; date: PlanDate; slot: MealSlot; body: string; optimisticEntry?: PlanEntry };
  return mutationOptions({
    mutationKey: mutationKeys.planNoteSaved,
    mutationFn: (vars: Vars) =>
      vars.entryId ? api.updateMealPlanNote({ entryId: vars.entryId, body: vars.body }) : api.addMealPlanNote({ date: vars.date, slot: vars.slot, body: vars.body }),
    ...optimisticOver<PlanWeek, Vars, unknown>(
      queryClient,
      queryKey,
      (current, vars) =>
        vars.entryId ? withNoteBody(current, vars.entryId, vars.body) : vars.optimisticEntry ? withEntriesAppended(current, vars.date, vars.slot, [vars.optimisticEntry]) : current,
      invalidateKey,
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
 * This is the one write that cannot use `optimisticOver`: that helper owns a
 * single key, and here the fact is spread across two. The lifecycle is the same
 * shape by hand — cancel, snapshot both, patch both, restore both, invalidate
 * both — including the {@link cacheScope} guard, scoped on the *ledger* key
 * because that is the entry two concurrent favourites (on two different recipes)
 * share. Without it, starring two recipes quickly makes the first to settle
 * refetch a list that does not yet carry the second star, and the second star
 * blinks off and back on.
 *
 * `vars.favorite` is the state the caller wants, not a "flip it" instruction, so
 * the patch is a plain assignment and does not have to know what the row said
 * when the tap happened. The server function is still a toggle, which is why
 * this stays online-only for M1 *and* M2 (replaying it twice flips twice); §5.2
 * replaces it with `setHouseholdRecipeFavorite({ recipeId, favorite })`, at
 * which point the wire matches these vars and the write can queue.
 */
export function toggleRecipeFavoriteMutation(queryClient: QueryClient, householdId: string) {
  type Vars = { recipeId: string; favorite: boolean };
  type Snapshot = { detail?: HouseholdRecipeDetail | null; rows?: HouseholdRecipeRow[] };
  const listKey = keys.household.recipes(householdId);
  const detailKey = (recipeId: string) => keys.household.recipe(householdId, recipeId);
  const scope = cacheScope(queryClient, listKey);
  return mutationOptions({
    mutationKey: mutationKeys.recipeFavorite,
    meta: scope.meta,
    mutationFn: (vars: Vars) => api.toggleHouseholdRecipeFavorite(vars.recipeId),
    onMutate: async (vars: Vars): Promise<Snapshot> => {
      await Promise.all([queryClient.cancelQueries({ queryKey: detailKey(vars.recipeId) }), queryClient.cancelQueries({ queryKey: listKey })]);
      const detail = queryClient.getQueryData<HouseholdRecipeDetail | null>(detailKey(vars.recipeId));
      const rows = queryClient.getQueryData<HouseholdRecipeRow[]>(listKey);
      // `null` is a real cached answer here ("not in your box"), so the guard is
      // on truthiness rather than on `undefined` — there is nothing to star.
      if (detail) queryClient.setQueryData(detailKey(vars.recipeId), { ...detail, favorite: vars.favorite } satisfies HouseholdRecipeDetail);
      if (rows) {
        queryClient.setQueryData(listKey, rows.map((row) => (row.recipeId === vars.recipeId ? { ...row, favorite: vars.favorite } : row)) satisfies HouseholdRecipeRow[]);
      }
      return { detail, rows };
    },
    // The detail key is unguarded and the ledger key is not, because only the
    // ledger is shared: two writes can overlap on it (two recipes, two stars),
    // while overlapping on one recipe's detail would take two taps on a button
    // that is disabled between them. Guarding the detail key as well would mean
    // a favourite that lost the race never revalidates its own recipe at all.
    onError: (_error: unknown, vars: Vars, context: Snapshot | undefined) => {
      if (context?.detail !== undefined) queryClient.setQueryData(detailKey(vars.recipeId), context.detail);
      if (context?.rows !== undefined && scope.isLastWrite()) queryClient.setQueryData(listKey, context.rows);
    },
    onSettled: async (_data: { favorite: boolean } | undefined, _error: unknown, vars: Vars) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: detailKey(vars.recipeId) }),
        scope.isLastWrite() ? queryClient.invalidateQueries({ queryKey: listKey }) : Promise.resolve(),
      ]);
    },
  });
}
