import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { FolderLock, Lock } from "lucide-react";
import { addRecipesToCollectionMutation, householdCollectionsQuery, removeRecipeFromCollectionMutation } from "#/lib/api";
import { OFFLINE_WRITE_HINT, useIsOnline } from "#/lib/offline/use-online";
import { Button } from "#/components/ui/button";
import { CheckboxRow } from "#/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "#/components/ui/dialog";

/**
 * "Which shelves does this recipe belong on?" — the desktop filing surface (§7).
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
 * rather than letting someone discover the rule by failure. In milestone 2 that
 * branch is unreachable — nothing can be published yet — but it is the shape
 * milestone 5 hangs the "Publish recipe & add" combo off, and shipping the
 * refusal now means M5 adds an action to an existing row instead of inventing a
 * state.
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
              const blocked = !filed && recipeUnpublished && collection.publishedAt != null;

              if (blocked) {
                return (
                  // TODO(m5): this row gains the "Publish recipe & add" action,
                  // which publishes the recipe and files it in one call
                  // (`addRecipesToCollection`'s `publishRecipeIds`).
                  <div
                    key={collection.id}
                    className="flex w-full items-center gap-3 rounded-lg border-2 border-dashed border-border/60 bg-muted/40 px-2.5 py-2 text-sm text-muted-foreground"
                  >
                    <Lock className="size-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{collection.name}</span>
                      <span className="block text-xs">Published shelf — this recipe is still private, so it can’t go on it yet.</span>
                    </span>
                  </div>
                );
              }

              return (
                <CheckboxRow
                  key={collection.id}
                  size="sm"
                  tone="selection"
                  checked={filed}
                  title={online ? undefined : OFFLINE_WRITE_HINT}
                  meta={`${collection.recipeIds.length}`}
                  onCheckedChange={(checked) => {
                    if (!online) return;
                    if (checked) file.mutate({ collectionId: collection.id, recipeIds: [recipeId] });
                    else unfile.mutate({ collectionId: collection.id, recipeId });
                  }}
                >
                  {collection.name}
                </CheckboxRow>
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
