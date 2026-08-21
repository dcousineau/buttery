import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { FolderLock } from "lucide-react";
import { addRecipesToCollectionMutation, householdCollectionsQuery, removeRecipeFromCollectionMutation } from "#/lib/api";
import { OFFLINE_WRITE_HINT, useIsOnline } from "#/lib/offline/use-online";
import { Button } from "#/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "#/components/ui/dialog";
import { CollectionCheckRow } from "./CollectionCheckRow";

/**
 * "Which shelves does this recipe belong on?" — the desktop filing surface (§7).
 * Below `md` the same question is asked by `FileRecipeSheet`, over the same rows.
 *
 * **Each tick files or unfiles immediately.** There is no Save: both writes are
 * optimistic over the one collections cache entry, so the chips behind the
 * dialog and the counts in the tree move on the same frame as the click, and a
 * dialog that asked you to confirm a checkbox would be asking twice for one
 * decision. The footer button just closes.
 *
 * The rows are `tone="selection"` — membership is a standing fact, not finished
 * work, so a checked shelf takes the butter fill rather than the checklist's
 * strike-through (see `ui/checkbox.tsx`).
 *
 * **Blocked rows.** A published collection may not hold an unpublished recipe
 * (§2.4); the server's preflight refuses it, so the row refuses it here too
 * rather than letting someone discover the rule by failure. That row lives in
 * `CollectionCheckRow` now, shared with the mobile sheet, so milestone 5 adds
 * "Publish recipe & add" in one place rather than two.
 */
export function CollectionPickerDialog({
  open,
  onOpenChange,
  householdId,
  recipeId,
  recipeTitle,
  recipeUnpublished,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  householdId: string;
  recipeId: string;
  recipeTitle: string;
  /** A private draft with no atproto record; blocked from published shelves. */
  recipeUnpublished: boolean;
}) {
  const { data: collections } = useSuspenseQuery(householdCollectionsQuery(householdId));
  const queryClient = useQueryClient();
  const online = useIsOnline();
  const file = useMutation(addRecipesToCollectionMutation(queryClient, householdId));
  const unfile = useMutation(removeRecipeFromCollectionMutation(queryClient, householdId));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="max-h-[80vh] overflow-auto">
        <DialogTitle>File this recipe</DialogTitle>
        <DialogDescription>
          Pick the shelves <span className="font-semibold text-foreground">{recipeTitle}</span> belongs on. Changes save as you tick.
        </DialogDescription>

        {collections.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-6 py-10 text-center">
            <FolderLock className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="m-0 text-[0.8125rem] font-bold text-foreground">No shelves yet</p>
            <p className="m-0 text-xs text-muted-foreground">Open the collections column beside your box and make one — it only needs a name.</p>
          </div>
        ) : (
          <div className="flex max-h-[18rem] flex-col gap-1 overflow-auto pr-0.5">
            {collections.map((collection) => {
              const filed = collection.recipeIds.includes(recipeId);
              return (
                <CollectionCheckRow
                  key={collection.id}
                  collection={collection}
                  filed={filed}
                  blocked={!filed && recipeUnpublished && collection.publishedAt != null}
                  size="sm"
                  disabledHint={online ? undefined : OFFLINE_WRITE_HINT}
                  onToggle={(checked) => {
                    if (checked) file.mutate({ collectionId: collection.id, recipeIds: [recipeId] });
                    else unfile.mutate({ collectionId: collection.id, recipeId });
                  }}
                />
              );
            })}
          </div>
        )}

        <DialogFooter>
          <DialogClose render={<Button />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
