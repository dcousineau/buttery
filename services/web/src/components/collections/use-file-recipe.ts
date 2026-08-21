import { useState } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { addRecipesToCollectionMutation, type CollectionSummary, householdCollectionsQuery, removeRecipeFromCollectionMutation } from "#/lib/api";
import { OFFLINE_WRITE_HINT, useIsOnline } from "#/lib/offline/use-online";
import { useRecipesView } from "#/components/recipes/context";
import { useStaleToast } from "./use-stale-toast";

/**
 * "Which shelves does this recipe belong on?", once — for the desktop picker
 * dialog and the mobile file sheet, which ask it identically and must answer it
 * identically.
 *
 * Milestone 4 left a note saying those two surfaces take the same props and that
 * a change to one has to be a change to both. Milestone 5 changed both at once
 * (the "Publish recipe & add" combo, the `stale` notice, the re-authorize
 * prompt), so the behaviour moved in here and the two components became what
 * they should be: layout.
 *
 * Every branch of `addRecipesToCollection`'s union is handled here, and every
 * one of them *resolves* rather than throwing (§5), so the optimistic patch is
 * never rolled back by `onError` — the `onSettled` invalidation is what corrects
 * a refused filing.
 */
export function useFileRecipe(householdId: string, recipeId: string, recipeTitle: string) {
  const { data: collections } = useSuspenseQuery(householdCollectionsQuery(householdId));
  const queryClient = useQueryClient();
  const online = useIsOnline();
  const { pushToast } = useRecipesView();
  const { notifyStale } = useStaleToast(householdId);
  const file = useMutation(addRecipesToCollectionMutation(queryClient, householdId));
  const unfile = useMutation(removeRecipeFromCollectionMutation(queryClient, householdId));

  /** The shelf whose combo is in flight, so only its button says "Publishing…". */
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [reauthOpen, setReauthOpen] = useState(false);

  async function fileInto(collection: CollectionSummary, publishFirst: boolean) {
    if (publishFirst) setPublishingId(collection.id);
    try {
      const result = await file.mutateAsync({
        collectionId: collection.id,
        recipeIds: [recipeId],
        // Consent is explicit and per-id: without this the server refuses the
        // private recipe rather than quietly making it public.
        publishRecipeIds: publishFirst ? [recipeId] : undefined,
      });
      if (result.ok) {
        if (publishFirst) pushToast(`Published ${recipeTitle} and filed it on ${collection.name}`);
        // The filing saved; the publisher's copy of the shelf is what is behind.
        if (result.stale) notifyStale(collection);
        return;
      }
      if (result.reason === "scope_error") {
        setReauthOpen(true);
        return;
      }
      if (result.reason === "flag_disabled") {
        pushToast("Publishing is switched off right now — nothing was filed", { variant: "default" });
        return;
      }
      pushToast(`${collection.name} is published, so it can only hold published recipes`, { variant: "default" });
    } catch {
      pushToast("That didn’t save. Try again", { variant: "default" });
    } finally {
      setPublishingId(null);
    }
  }

  function unfileFrom(collection: CollectionSummary) {
    unfile.mutate(
      { collectionId: collection.id, recipeId },
      {
        onSuccess: (result) => {
          if (result.stale) notifyStale(collection);
        },
      },
    );
  }

  return {
    collections,
    online,
    disabledHint: online ? undefined : OFFLINE_WRITE_HINT,
    filedCount: collections.filter((collection) => collection.recipeIds.includes(recipeId)).length,
    publishingId,
    reauthOpen,
    setReauthOpen,
    /** A tick or an untick on one shelf — files and unfiles immediately. */
    toggle: (collection: CollectionSummary, checked: boolean) => {
      if (checked) void fileInto(collection, false);
      else unfileFrom(collection);
    },
    /** The blocked row's escape hatch: publish this recipe, then file it (§5). */
    publishAndAdd: (collection: CollectionSummary) => void fileInto(collection, true),
  };
}
