import { FolderLock } from "lucide-react";
import { AtprotoReauthDialog } from "#/components/AtprotoReauthDialog";
import { Button } from "#/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "#/components/ui/sheet";
import { CollectionCheckRow } from "./CollectionCheckRow";
import { useFileRecipe } from "./use-file-recipe";

/**
 * "File this recipe" — one recipe into many collections, on a phone (§7).
 *
 * The mobile twin of `CollectionPickerDialog`, and deliberately the *same
 * interaction*: each tick files or unfiles immediately, both writes are
 * optimistic over the one collections cache entry, and the footer button only
 * closes. What changes is the shape — a bottom sheet with a thumb-sized row,
 * because **mobile has no drag** (§7): sheets are the whole filing mechanism,
 * so this is not a convenience next to a drag target, it is the only way a
 * recipe gets into a collection from a phone.
 *
 * Rows are the shared `CollectionCheckRow` at `size="default"` — 48px, past the
 * 44px floor §7 mandates, with `min-h-11` under it so it stays there. The
 * behaviour behind them is the shared `useFileRecipe`, so this surface and the
 * desktop dialog cannot drift: same refusals, same "Publish recipe & add", same
 * stale notice.
 */
export function FileRecipeSheet({
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
  /** A private draft with no atproto record; blocked from published collections (§2.4). */
  recipeUnpublished: boolean;
}) {
  const { collections, disabledHint, filedCount, publishingId, publishAndAdd, reauthOpen, setReauthOpen, toggle } = useFileRecipe(householdId, recipeId, recipeTitle);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/*
        `max-h` rather than a height: a household with two collections gets a sheet
        two collections tall, and only a long list grows to most of the screen and
        scrolls inside itself. The `data-[side=bottom]:` modifier is repeated on
        the radius so it beats the primitive's own attribute-selector rule.
      */}
      <SheetContent side="bottom" showCloseButton={false} className="max-h-[85svh] gap-0 p-0 data-[side=bottom]:rounded-t-xl">
        <SheetHeader className="flex-none border-b-2 border-border px-4 py-3">
          <SheetTitle className="display-title text-lg">File this recipe</SheetTitle>
          <SheetDescription>
            Pick the collections <span className="font-semibold text-foreground">{recipeTitle}</span> belongs in. Changes save as you tick.
          </SheetDescription>
        </SheetHeader>

        {collections.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-6 py-10 text-center">
            <FolderLock className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="m-0 text-[0.8125rem] font-bold text-foreground">No collections yet</p>
            <p className="m-0 text-xs text-pretty text-muted-foreground">Go back to your box and make one from the collections button — it only needs a name.</p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
            {collections.map((collection) => {
              const filed = collection.recipeIds.includes(recipeId);
              return (
                <CollectionCheckRow
                  key={collection.id}
                  collection={collection}
                  filed={filed}
                  blocked={!filed && recipeUnpublished && collection.publishedAt != null}
                  size="default"
                  disabledHint={disabledHint}
                  onToggle={(checked) => toggle(collection, checked)}
                  onPublishAndAdd={() => publishAndAdd(collection)}
                  publishing={publishingId === collection.id}
                />
              );
            })}
          </div>
        )}

        <SheetFooter className="flex-none border-t-2 border-border">
          {/* A running count, because the sheet covers the chips it changes —
            on a phone there is nothing behind it to watch move. */}
          <p className="m-0 text-center text-xs text-muted-foreground" role="status" aria-live="polite">
            {filedCount === 0 ? "Not in any collection yet" : `In ${filedCount} ${filedCount === 1 ? "collection" : "collections"}`}
          </p>
          <SheetClose render={<Button size="lg" className="h-11 w-full" />}>Done</SheetClose>
        </SheetFooter>

        {/* The combo publishes a *recipe*: an under-scoped grant refuses it here
          exactly as it does on the recipe's own publish button. */}
        <AtprotoReauthDialog open={reauthOpen} onOpenChange={setReauthOpen} touch />
      </SheetContent>
    </Sheet>
  );
}
