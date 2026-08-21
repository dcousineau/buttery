import { useQueryClient } from "@tanstack/react-query";
import { keys, retryCollectionSync } from "#/lib/api";
import { useRecipesView } from "#/components/recipes/context";

/**
 * The one place the "published copy is behind" message is written (§5).
 *
 * **Every write that can re-put now answers with `stale`** — `updateCollection`,
 * `reorderCollectionRecipes`, `addRecipesToCollection`, `removeRecipeFromCollection`
 * — and `stale: true` never means the write failed. The local rows are saved; what
 * did not happen is the re-put onto the publisher's PDS. So this is a *notice*
 * with a retry, not an error: nothing is rolled back, nothing is blocked, and any
 * later successful write on the same collection clears the flag on its own.
 *
 * Seven call sites push it (the edit dialog's save, its member removal and its
 * move controls, the ledger's reorder, the tree's drag-to-file, the picker and
 * the two mobile sheets), which is exactly why the sentence lives here instead of
 * at any of them.
 *
 * The retry is `retryCollectionSync`, which is **member-level, not owner-only**:
 * whoever made the edit is the person standing in front of the message, and
 * telling them to fetch an owner would be a dead end.
 */

/**
 * "@sam", or an honest fallback when the handle could not be resolved.
 *
 * The two sources spell it differently — `CollectionSummary.publishedByHandle`
 * comes from `resolveAdderHandles`, which already prefixes the `@`, while the
 * session's own `handle` is bare — so the `@` is normalized here rather than at
 * six call sites (and rather than rendering "@@chef.test", which is what
 * prefixing unconditionally did).
 */
export function publisherName(handle: string | null | undefined): string {
  if (!handle) return "the publisher";
  return handle.startsWith("@") ? handle : `@${handle}`;
}

/** What the toast needs to know about the collection whose copy went behind. */
export interface StaleCollection {
  id: string;
  publishedByHandle: string | null;
}

export function useStaleToast(householdId: string) {
  const queryClient = useQueryClient();
  const { pushToast } = useRecipesView();

  function notify(collection: StaleCollection, again = false) {
    const who = publisherName(collection.publishedByHandle);
    pushToast(again ? `Still couldn’t update ${who}’s published copy` : `Saved — couldn’t update ${who}’s published copy yet`, {
      variant: "default",
      description: "Your change is saved here. The next edit to this collection will try again, or retry now.",
      action: { label: "Retry", onClick: () => void retry(collection) },
      // A message with a button has to outlast the four seconds a confirmation gets.
      sticky: true,
    });
  }

  async function retry(collection: StaleCollection) {
    try {
      const { stale } = await retryCollectionSync(collection.id);
      // The badge in the edit dialog reads `recordStale` off this entry, so the
      // two surfaces agree the moment the retry lands either way.
      await queryClient.invalidateQueries({ queryKey: keys.household.collections(householdId) });
      if (stale) notify(collection, true);
      else pushToast(`${publisherName(collection.publishedByHandle)}’s published copy is up to date`);
    } catch {
      notify(collection, true);
    }
  }

  return { notifyStale: notify, retrySync: retry };
}
