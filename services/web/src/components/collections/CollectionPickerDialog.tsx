import { FolderLock } from "lucide-react";
import { AtprotoReauthDialog } from "#/components/AtprotoReauthDialog";
import { Button } from "#/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "#/components/ui/dialog";
import { CollectionCheckRow } from "./CollectionCheckRow";
import { useFileRecipe } from "./use-file-recipe";

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
 * rather than letting someone discover the rule by failure — and offers
 * "Publish recipe & add", which does both in one call (§5). Both the row and the
 * behaviour behind it are shared with the mobile sheet (`CollectionCheckRow`,
 * `use-file-recipe.ts`); this file is layout.
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
  const { collections, disabledHint, publishingId, publishAndAdd, reauthOpen, setReauthOpen, toggle } = useFileRecipe(householdId, recipeId, recipeTitle);

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
                  disabledHint={disabledHint}
                  onToggle={(checked) => toggle(collection, checked)}
                  onPublishAndAdd={() => publishAndAdd(collection)}
                  publishing={publishingId === collection.id}
                />
              );
            })}
          </div>
        )}

        <DialogFooter>
          <DialogClose render={<Button />}>Done</DialogClose>
        </DialogFooter>

        {/* The combo publishes a *recipe*, so an under-scoped grant refuses it
          the same way the recipe detail's own publish button does. */}
        <AtprotoReauthDialog open={reauthOpen} onOpenChange={setReauthOpen} />
      </DialogContent>
    </Dialog>
  );
}
