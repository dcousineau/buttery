/**
 * The transport adapter — **the only client module allowed to import `#/server/**`**
 * (offline plan §4.3, enforced by `src/lib/api/no-server-imports.test.ts` and by
 * the `no-restricted-imports` rule in `.oxlintrc.json`).
 *
 * Everything above this file — components, routes, `queries.ts`, `mutations.ts`,
 * the mirror — depends on the plain async functions exported here, never on a
 * `createServerFn` handle. That is the whole point of §7: when the API service is
 * extracted, this one file is rewritten to `fetch()` and nothing else moves.
 *
 * Two conventions, both deliberate:
 *
 * - **Natural arguments, not the `{ data }` envelope.** `getHouseholdRecipe(id)`,
 *   not `getHouseholdRecipe({ data: { recipeId: id } })`. The envelope is a
 *   TanStack Start transport detail; a REST adapter would have no use for it, and
 *   leaking it to 50 call sites is exactly the "scattered call sites" §7 names as
 *   the reason extractions fail.
 * - **No retry, no caching, no error translation.** Retry belongs to Query's
 *   retry predicate, caching to the query cache, and turning a thrown error into
 *   UI copy to the screen that shows it. This file is a wire, following the
 *   precedent set by `src/lib/recipe-import/api.ts`.
 *
 * `householdId` appears in no signature below. The server reads the active
 * household from the session and never accepts it as an argument (§2.4); it is a
 * client-side cache partition only, and lives in the query keys.
 */

import {
  addRecipeToHousehold as addRecipeToHouseholdFn,
  getHouseholdRecipe as getHouseholdRecipeFn,
  listHouseholdRecipes as listHouseholdRecipesFn,
  removeRecipeFromHousehold as removeRecipeFromHouseholdFn,
  searchGlobalRecipes as searchGlobalRecipesFn,
  toggleHouseholdRecipeFavorite as toggleHouseholdRecipeFavoriteFn,
  upsertHouseholdRecipeNote as upsertHouseholdRecipeNoteFn,
} from "#/server/household-recipes";
import type { AddRecipesToCollectionResult, DeleteCollectionResult, PublishCollectionResult, UnpublishCollectionResult } from "#/server/collections";
import {
  addRecipesToCollection as addRecipesToCollectionFn,
  createCollection as createCollectionFn,
  deleteCollection as deleteCollectionFn,
  listCollections as listCollectionsFn,
  publishCollection as publishCollectionFn,
  removeRecipeFromCollection as removeRecipeFromCollectionFn,
  reorderCollectionRecipes as reorderCollectionRecipesFn,
  reorderCollections as reorderCollectionsFn,
  retryCollectionSync as retryCollectionSyncFn,
  unpublishCollection as unpublishCollectionFn,
  updateCollection as updateCollectionFn,
} from "#/server/collections";
import {
  addMealPlanNote as addMealPlanNoteFn,
  addMealPlanRecipes as addMealPlanRecipesFn,
  copyMealPlanWeek as copyMealPlanWeekFn,
  getCookedCandidates as getCookedCandidatesFn,
  getMealPlanWeek as getMealPlanWeekFn,
  getPlanToday as getPlanTodayFn,
  getPlannedUsageForRecipe as getPlannedUsageForRecipeFn,
  moveMealPlanEntry as moveMealPlanEntryFn,
  removeMealPlanEntry as removeMealPlanEntryFn,
  setMealPlanEntryCooked as setMealPlanEntryCookedFn,
  updateMealPlanNote as updateMealPlanNoteFn,
} from "#/server/meal-plan";
import {
  addManualGroceryItem as addManualGroceryItemFn,
  clearAllGroceryItems as clearAllGroceryItemsFn,
  clearPurchasedGroceryItems as clearPurchasedGroceryItemsFn,
  commitGroceryAdd as commitGroceryAddFn,
  deleteAllGroceryItems as deleteAllGroceryItemsFn,
  getGroceryList as getGroceryListFn,
  previewGroceryAdd as previewGroceryAddFn,
  removeGroceryItem as removeGroceryItemFn,
  toggleGroceryItem as toggleGroceryItemFn,
  updateGroceryItem as updateGroceryItemFn,
} from "#/server/grocery";
import {
  acceptBoundInviteById as acceptBoundInviteByIdFn,
  declineBoundInviteById as declineBoundInviteByIdFn,
  listHouseholdMembers as listHouseholdMembersFn,
  requireActiveHousehold as requireActiveHouseholdFn,
  resolveHomeRedirect as resolveHomeRedirectFn,
  resolveOnboarding as resolveOnboardingFn,
  switchActiveHousehold as switchActiveHouseholdFn,
} from "#/server/household/onboarding";
import {
  createHousehold as createHouseholdFn,
  deleteHousehold as deleteHouseholdFn,
  listMyHouseholds as listMyHouseholdsFn,
  renameHousehold as renameHouseholdFn,
} from "#/server/household/households";
import {
  acceptInvite as acceptInviteFn,
  createInvite as createInviteFn,
  declineBoundInvite as declineBoundInviteFn,
  getInvitePreview as getInvitePreviewFn,
  listInvites as listInvitesFn,
  revokeInvite as revokeInviteFn,
} from "#/server/household/invites";
import { leaveHousehold as leaveHouseholdFn, removeMember as removeMemberFn, setMemberRole as setMemberRoleFn } from "#/server/household/members";
import {
  DEFAULT_HOUSEHOLD_PREFERENCES as DEFAULT_HOUSEHOLD_PREFERENCES_,
  getHouseholdPreferences as getHouseholdPreferencesFn,
  supportedTimezones as supportedTimezones_,
  updateHouseholdPreferences as updateHouseholdPreferencesFn,
} from "#/server/household/preferences";
import { dismissInviteNudge as dismissInviteNudgeFn, getHouseholdNudges as getHouseholdNudgesFn } from "#/server/household/settings";
import { clearPendingInvite as clearPendingInviteFn, errorMessage as errorMessage_, stashPendingInvite as stashPendingInviteFn } from "#/server/household/pending-invite";
import { getRecipe as getRecipeFn, listRecentRecipes as listRecentRecipesFn } from "#/server/recipes";
import {
  getRecipeDebugPayload as getRecipeDebugPayloadFn,
  triggerEnrichPayload as triggerEnrichPayloadFn,
  triggerLlmEnrichPayload as triggerLlmEnrichPayloadFn,
} from "#/server/recipe-debug";
import { createRecipeImageUpload as createRecipeImageUploadFn, publishRecipe as publishRecipeFn, saveRecipe as saveRecipeFn } from "#/server/recipes-write";
import { getImportPrefill as getImportPrefillFn, scrapeRecipe as scrapeRecipeFn, submitImport as submitImportFn } from "#/server/recipe-scrape";
import type { CommitChunkInput, ComparisonInput, FailImportSessionInput, FinalizeInput, OpenImportSessionInput, ProbeInput } from "#/server/recipe-import";
import {
  commitImportChunk as commitImportChunkFn,
  failImportSession as failImportSessionFn,
  finalizeImportSession as finalizeImportSessionFn,
  getImportComparison as getImportComparisonFn,
  openImportSession as openImportSessionFn,
  probeImportDuplicates as probeImportDuplicatesFn,
} from "#/server/recipe-import";

import type {
  CollectionSummary,
  CopiedWeek,
  CreatedPlanEntry,
  GlobalRecipeResult,
  GroceryListPayload,
  GroceryCommitRow,
  GroceryItemPatch,
  GroceryPreview,
  GroceryPreviewInput,
  HouseholdMemberView,
  HouseholdNudges,
  HouseholdPreferences,
  HouseholdRecipeDetail,
  HouseholdRecipeNoteView,
  HouseholdRecipeRow,
  HouseholdSummary,
  InvitePreview,
  InviteSummary,
  OnboardingVerdict,
  PlanWeek,
  PlannedUsage,
  RecipeCardData,
  RecipeDetailData,
} from "./types";
import type { MealSlot, PlanDate } from "#/lib/plan/week";

// --- pure helpers that happen to live server-side ------------------------
//
// Not transport: no round trip, no `createServerFn`. They are re-exported here
// only because the §4.3 rule is "one module knows about `#/server/**`", and
// splitting them out would create a second one for no benefit. Each is a plain
// value or pure function that already runs in the browser today.

export const DEFAULT_HOUSEHOLD_PREFERENCES = DEFAULT_HOUSEHOLD_PREFERENCES_;
export const supportedTimezones = supportedTimezones_;
export const errorMessage = errorMessage_;
/** Cookie writes, not round trips — the pending-invite handoff is client-side. */
export const stashPendingInvite = stashPendingInviteFn;
export const clearPendingInvite = clearPendingInviteFn;

// --- the household recipe box -------------------------------------------

export function listHouseholdRecipes(): Promise<HouseholdRecipeRow[]> {
  return listHouseholdRecipesFn();
}

export function getHouseholdRecipe(recipeId: string): Promise<HouseholdRecipeDetail | null> {
  return getHouseholdRecipeFn({ data: { recipeId } });
}

export function addRecipeToHousehold(recipeId: string): Promise<{ ok: true }> {
  return addRecipeToHouseholdFn({ data: { recipeId } });
}

export function removeRecipeFromHousehold(recipeId: string): Promise<{ ok: true }> {
  return removeRecipeFromHouseholdFn({ data: { recipeId } });
}

/**
 * Server-side toggle: the client sends no desired state, so replaying it twice
 * flips twice. That is why it stays online-only in M1 and why M2 replaces it
 * with an absolute `setHouseholdRecipeFavorite({ recipeId, favorite })` (§5.2).
 */
export function toggleHouseholdRecipeFavorite(recipeId: string): Promise<{ favorite: boolean }> {
  return toggleHouseholdRecipeFavoriteFn({ data: { recipeId } });
}

export function upsertHouseholdRecipeNote(input: { recipeId: string; body: string }): Promise<HouseholdRecipeNoteView | null> {
  return upsertHouseholdRecipeNoteFn({ data: input });
}

export function searchGlobalRecipes(input: { q?: string; limit?: number; cursor?: string | null }): Promise<{ results: GlobalRecipeResult[]; nextCursor: string | null }> {
  return searchGlobalRecipesFn({ data: input });
}

// --- collections --------------------------------------------------------

/**
 * The collection result unions live beside the server fns that return them (the
 * way `SaveRecipeResult` does), and are re-exported here so the UI has one
 * address to import from — every one of their `ok: false` arms is a decision to
 * render (publish this recipe first, re-authorize, retry later), not an error to
 * throw away.
 *
 * Note that publish, unpublish and delete all **resolve** their refusals and are
 * non-optimistic (§6): there is no cache patch to roll back, so the caller reads
 * the union and invalidates `keys.household.collections(hid)` either way.
 */
export type { AddRecipesToCollectionResult, DeleteCollectionResult, PublishCollectionResult, UnpublishCollectionResult };

export function listCollections(): Promise<CollectionSummary[]> {
  return listCollectionsFn();
}

export function createCollection(input: { name: string; description?: string }): Promise<CollectionSummary> {
  return createCollectionFn({ data: input });
}

/**
 * `stale` rides along on every write that can change a published record: the
 * local save succeeded, the copy on the publisher's PDS did not get updated.
 * Surface it as "Saved — couldn't update @handle's published copy yet" with a
 * retry (`retryCollectionSync`); never as a failed save.
 */
export function updateCollection(input: { collectionId: string; name?: string; description?: string | null }): Promise<{ updated: boolean; stale: boolean }> {
  return updateCollectionFn({ data: input });
}

export function reorderCollections(orderedIds: string[]): Promise<{ reordered: boolean }> {
  return reorderCollectionsFn({ data: { orderedIds } });
}

export function reorderCollectionRecipes(input: { collectionId: string; orderedRecipeIds: string[] }): Promise<{ reordered: boolean; stale: boolean }> {
  return reorderCollectionRecipesFn({ data: input });
}

/**
 * File recipes into a collection. `publishRecipeIds` is the "Publish recipe &
 * add" combo (§5): the ids the user agreed to publish first, which must be a
 * subset of `recipeIds`. Anything unpublished and NOT listed there still comes
 * back as `recipes_unpublished`.
 */
export function addRecipesToCollection(input: { collectionId: string; recipeIds: string[]; publishRecipeIds?: string[] }): Promise<AddRecipesToCollectionResult> {
  return addRecipesToCollectionFn({ data: input });
}

export function removeRecipeFromCollection(input: { collectionId: string; recipeId: string }): Promise<{ removed: boolean; stale: boolean }> {
  return removeRecipeFromCollectionFn({ data: input });
}

/** Owner-only. Deletes the PDS record first; a refusal means nothing was deleted. */
export function deleteCollection(collectionId: string): Promise<DeleteCollectionResult> {
  return deleteCollectionFn({ data: { collectionId } });
}

/** Owner-only. The acting owner becomes the publisher every re-put goes through (§2.5). */
export function publishCollection(collectionId: string): Promise<PublishCollectionResult> {
  return publishCollectionFn({ data: { collectionId } });
}

/** Owner-only. Removes the PDS record and keeps the local collection (§2.7). */
export function unpublishCollection(collectionId: string): Promise<UnpublishCollectionResult> {
  return unpublishCollectionFn({ data: { collectionId } });
}

/** The stale badge's retry: re-runs the re-put and reports whether it is still behind. */
export function retryCollectionSync(collectionId: string): Promise<{ stale: boolean }> {
  return retryCollectionSyncFn({ data: { collectionId } });
}

// --- the meal plan ------------------------------------------------------

export function getMealPlanWeek(week?: PlanDate): Promise<PlanWeek> {
  return getMealPlanWeekFn({ data: { week } });
}

export function getPlanToday(): Promise<{ today: PlanDate; timezone: string }> {
  return getPlanTodayFn();
}

export function getPlannedUsageForRecipe(recipeId: string): Promise<PlannedUsage> {
  return getPlannedUsageForRecipeFn({ data: { recipeId } });
}

export function getCookedCandidates(recipeId: string): Promise<Array<{ entryId: string; slot: MealSlot; date: PlanDate }>> {
  return getCookedCandidatesFn({ data: { recipeId } });
}

export function addMealPlanRecipes(input: { date: PlanDate; slot: MealSlot; recipeIds: string[] }): Promise<CreatedPlanEntry[]> {
  return addMealPlanRecipesFn({ data: input });
}

export function addMealPlanNote(input: { date: PlanDate; slot: MealSlot; body: string }): Promise<CreatedPlanEntry> {
  return addMealPlanNoteFn({ data: input });
}

export function updateMealPlanNote(input: { entryId: string; body: string }): Promise<{ removed: boolean }> {
  return updateMealPlanNoteFn({ data: input });
}

export function moveMealPlanEntry(input: { entryId: string; toDate: PlanDate; toSlot: MealSlot }): Promise<{ moved: boolean }> {
  return moveMealPlanEntryFn({ data: input });
}

export function removeMealPlanEntry(entryId: string): Promise<{ removed: boolean }> {
  return removeMealPlanEntryFn({ data: { entryId } });
}

export function setMealPlanEntryCooked(input: { entryId: string; cooked: boolean }): Promise<{ cookedAt: string | null }> {
  return setMealPlanEntryCookedFn({ data: input });
}

export function copyMealPlanWeek(input: { fromWeek: PlanDate; toWeek: PlanDate; mode: "append" | "replace" }): Promise<CopiedWeek> {
  return copyMealPlanWeekFn({ data: input });
}

// --- the grocery list ---------------------------------------------------

export function getGroceryList(): Promise<GroceryListPayload> {
  return getGroceryListFn();
}

export function previewGroceryAdd(input: GroceryPreviewInput): Promise<GroceryPreview> {
  return previewGroceryAddFn({ data: input });
}

export function commitGroceryAdd(input: { rows: GroceryCommitRow[] }): Promise<{ added: number; merged: number }> {
  return commitGroceryAddFn({ data: input });
}

export function addManualGroceryItem(text: string): Promise<{ itemId: string; merged: boolean }> {
  return addManualGroceryItemFn({ data: { text } });
}

export function toggleGroceryItem(input: { itemId: string; checked: boolean }): Promise<{ checkedAt: string | null }> {
  return toggleGroceryItemFn({ data: input });
}

export function updateGroceryItem(input: GroceryItemPatch): Promise<{ updated: boolean }> {
  return updateGroceryItemFn({ data: input });
}

export function removeGroceryItem(itemId: string): Promise<{ removed: boolean }> {
  return removeGroceryItemFn({ data: { itemId } });
}

export function clearPurchasedGroceryItems(): Promise<{ cleared: number }> {
  return clearPurchasedGroceryItemsFn();
}

export function clearAllGroceryItems(): Promise<{ cleared: number }> {
  return clearAllGroceryItemsFn();
}

export function deleteAllGroceryItems(): Promise<{ removed: number }> {
  return deleteAllGroceryItemsFn();
}

// --- households, members, invites, onboarding ---------------------------

export function requireActiveHousehold(): Promise<{ householdId: string; name: string }> {
  return requireActiveHouseholdFn();
}

export function resolveOnboarding(): Promise<OnboardingVerdict> {
  return resolveOnboardingFn();
}

/**
 * The post-login pivot on `/`. Redirects a signed-in caller into the app and
 * resolves `{ authed: false }` for everyone else — so its *return* type is the
 * uninteresting half and the throw is the point.
 */
export function resolveHomeRedirect(): Promise<{ authed: false }> {
  return resolveHomeRedirectFn();
}

export function switchActiveHousehold(householdId: string) {
  return switchActiveHouseholdFn({ data: { householdId } });
}

export function listMyHouseholds(): Promise<HouseholdSummary[]> {
  return listMyHouseholdsFn();
}

export function listHouseholdMembers(householdId: string): Promise<HouseholdMemberView[]> {
  return listHouseholdMembersFn({ data: { householdId } });
}

export function createHousehold(name: string) {
  return createHouseholdFn({ data: { name } });
}

export function renameHousehold(input: { householdId: string; name: string }) {
  return renameHouseholdFn({ data: input });
}

export function deleteHousehold(householdId: string) {
  return deleteHouseholdFn({ data: { householdId } });
}

export function leaveHousehold(householdId: string) {
  return leaveHouseholdFn({ data: { householdId } });
}

export function removeMember(input: { householdId: string; did: string }) {
  return removeMemberFn({ data: input });
}

type SetMemberRoleInput = Parameters<typeof setMemberRoleFn>[0] extends { data: infer D } ? D : never;

export function setMemberRole(input: SetMemberRoleInput) {
  return setMemberRoleFn({ data: input });
}

export function listInvites(householdId: string): Promise<InviteSummary[]> {
  return listInvitesFn({ data: { householdId } });
}

type CreateInviteInput = Parameters<typeof createInviteFn>[0] extends { data: infer D } ? D : never;

export function createInvite(input: CreateInviteInput) {
  return createInviteFn({ data: input });
}

export function revokeInvite(inviteId: string) {
  return revokeInviteFn({ data: { inviteId } });
}

export function getInvitePreview(token: string): Promise<InvitePreview> {
  return getInvitePreviewFn({ data: { token } });
}

export function acceptInvite(token: string) {
  return acceptInviteFn({ data: { token } });
}

export function declineBoundInvite(token: string) {
  return declineBoundInviteFn({ data: { token } });
}

export function acceptBoundInviteById(inviteId: string) {
  return acceptBoundInviteByIdFn({ data: { inviteId } });
}

export function declineBoundInviteById(inviteId: string) {
  return declineBoundInviteByIdFn({ data: { inviteId } });
}

/**
 * The pantry's first-run nudges. Takes the household id explicitly (unlike most
 * fns here) because the pantry loader already holds it and the server would
 * otherwise re-derive the same value from the session.
 */
export function getHouseholdNudges(householdId: string): Promise<HouseholdNudges> {
  return getHouseholdNudgesFn({ data: { householdId } });
}

export function dismissInviteNudge(householdId: string): Promise<{ ok: true }> {
  return dismissInviteNudgeFn({ data: { householdId } });
}

export function getHouseholdPreferences(): Promise<HouseholdPreferences> {
  return getHouseholdPreferencesFn();
}

export function updateHouseholdPreferences(input: HouseholdPreferences): Promise<HouseholdPreferences> {
  return updateHouseholdPreferencesFn({ data: input });
}

// --- the public recipe surface ------------------------------------------

export function listRecentRecipes(): Promise<RecipeCardData[]> {
  return listRecentRecipesFn();
}

/** Takes the id bare, not enveloped — `getRecipe`'s validator is `(id: string)`. */
export function getRecipe(recipeId: string): Promise<RecipeDetailData | null> {
  return getRecipeFn({ data: recipeId });
}

// --- recipe-enrichment dev panel (recipe-enrichment plan §10, D16) -------
//
// The enrichment VIEW TYPES only. The server fn that used to sit here went with
// the pinned overlay panel it fed — the devtools Recipe inspector reads the
// enrichment tables raw through `getRecipeDebug` below, which is the one debug
// entry point now.

export type { RecipeEnrichmentView, RecipeEnrichmentLabelView } from "#/server/recipe-enrichment";

// --- recipe debug panel (RecipeDebugPayload, devtools/types.ts) ----------
//
// Same deal as the enrichment panel above: dev-only, no `queryOptions`
// factory, read imperatively by the devtools panel. `getRecipeDebugPayloadFn`
// re-checks `NODE_ENV` on the server and refuses outright in production
// regardless of what a caller sends. Re-exported here as `getRecipeDebug` —
// the server module names its createServerFn export `getRecipeDebugPayload`
// only to avoid colliding with the plain, db-first function of the same
// name; this is the name callers actually want. The wire types
// (`RecipeDebugPayload` and friends) already live in `#/devtools/types.ts`,
// a client-safe module outside `#/server/**`, so the panel imports them
// straight from there — no re-export needed here.

export function getRecipeDebug(recipeId: string) {
  return getRecipeDebugPayloadFn({ data: { recipeId } });
}

/**
 * The panel's "run LLM enrichment now" button (`devtools/EnrichRunButtons.tsx`).
 * Same re-export reasoning as `getRecipeDebug` above — `triggerLlmEnrichPayload`
 * re-checks `NODE_ENV` on the server regardless of what shipped client-side.
 * See `server/recipe-debug.ts`'s doc for the authorization/box-check gate and
 * `server/enrichment-queue.ts`'s `enqueueLlmEnrich` for what the returned
 * `EnrichTriggerResult` (`devtools/types.ts`) actually means.
 */
export function triggerLlmEnrich(recipeId: string) {
  return triggerLlmEnrichPayloadFn({ data: { recipeId } });
}

/**
 * The panel's other button, beside the one above: run the RULES pass now,
 * which on success hands off to the LLM pass too. Same gate, same return
 * type; `server/enrichment-queue.ts`'s `enqueueEnrichNow` has the reasoning
 * for why a panel that could already trigger the LLM still needed this.
 */
export function triggerEnrich(recipeId: string) {
  return triggerEnrichPayloadFn({ data: { recipeId } });
}

// --- authoring, scraping, import (online-only, §1.1) ---------------------

type SaveRecipeArgs = Parameters<typeof saveRecipeFn>[0] extends { data: infer D } ? D : never;
type ScrapeArgs = Parameters<typeof scrapeRecipeFn>[0] extends { data: infer D } ? D : never;
type SubmitImportArgs = Parameters<typeof submitImportFn>[0] extends { data: infer D } ? D : never;

/**
 * The recipe record shape and its field issues come from `#/lib/recipe-record`
 * (which owns the lexicon gate) and are re-exported here so an authoring screen
 * has one address to import from rather than two.
 */
export type { FieldIssue, RecipeRecordInput } from "#/lib/recipe-record";

export function saveRecipe(input: SaveRecipeArgs) {
  return saveRecipeFn({ data: input });
}

export function publishRecipe(recipeId: string) {
  return publishRecipeFn({ data: { recipeId } });
}

/**
 * Sign a URL for one recipe photo the browser is about to PUT into Buttery's
 * bucket. The bytes go straight there and never cross this transport — see
 * `#/lib/recipe-image-upload`, the only caller.
 */
export function createRecipeImageUpload(input: { mime: string; size: number }) {
  return createRecipeImageUploadFn({ data: input });
}

export function scrapeRecipe(input: ScrapeArgs) {
  return scrapeRecipeFn({ data: input });
}

export function getImportPrefill(importId: string) {
  return getImportPrefillFn({ data: { id: importId } });
}

export function submitImport(input: SubmitImportArgs) {
  return submitImportFn({ data: input });
}

/**
 * The Paprika/bulk import flow. Shaped as the `ImportApi` port in
 * `src/lib/recipe-import/contracts.ts` expects — that module predates this one
 * and proved the idiom ("swapping the transport is one file"); this is the same
 * seam, widened to the whole app.
 */
export const importTransport = {
  openSession: (data: OpenImportSessionInput) => openImportSessionFn({ data }),
  probeDuplicates: (data: ProbeInput) => probeImportDuplicatesFn({ data }),
  getComparison: (data: ComparisonInput) => getImportComparisonFn({ data }),
  commitChunk: (data: CommitChunkInput) => commitImportChunkFn({ data }),
  finalizeSession: (data: FinalizeInput) => finalizeImportSessionFn({ data }),
  failSession: (data: FailImportSessionInput) => failImportSessionFn({ data }),
};
