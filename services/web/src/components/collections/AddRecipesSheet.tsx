import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpenText, Lock, UtensilsCrossed } from "lucide-react";
import { addRecipesToCollectionMutation, type CollectionSummary, type HouseholdRecipeRow } from "#/lib/api";
import { OFFLINE_WRITE_HINT, useIsOnline } from "#/lib/offline/use-online";
import { AtprotoReauthDialog } from "#/components/AtprotoReauthDialog";
import { Button } from "#/components/ui/button";
import { CheckboxRow } from "#/components/ui/checkbox";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "#/components/ui/sheet";
import { searchRows } from "./scope";
import { useStaleToast } from "./use-stale-toast";

/**
 * "Add recipes" — many recipes onto one shelf, on a phone (§7).
 *
 * The other half of mobile's filing story. `FileRecipeSheet` starts from a
 * recipe ("which shelves does this belong on?"); this starts from the shelf
 * ("what goes on here?"), which is the question you have with an empty
 * collection in front of you and thirty recipes in the box. On a desktop that
 * job belongs to dragging a ledger card onto a collection row; **mobile has no
 * drag** (§7), so it is this.
 *
 * Unlike the tick-to-save picker, this one **batches**: a selection, then one
 * `addRecipesToCollection` call. Filing fifteen recipes one request at a time
 * would be fifteen optimistic patches racing one another's `onSettled`
 * invalidation, and the server appends in the order it is given — so one call
 * is also the only way the resulting shelf order matches the order they were
 * ticked.
 *
 * Rows are 44px+ (§7) and two-line: a title alone is not enough to tell two
 * "Chana masala"s apart, and the source line is what does it in the ledger too.
 *
 * **The refusal has an escape hatch.** A published shelf cannot hold a private
 * recipe (§2.4), and a batch is the one place that can be true of several
 * recipes at once — so the footer's refusal grows a single "Publish N & add"
 * that re-sends the same selection with those ids in `publishRecipeIds`. The
 * consent is one press for the batch the person can see listed, and the server
 * still publishes only the ids it was given.
 */
export function AddRecipesSheet({
  open,
  onOpenChange,
  collection,
  recipes,
  householdId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collection: CollectionSummary;
  recipes: HouseholdRecipeRow[];
  householdId: string;
}) {
  const queryClient = useQueryClient();
  const online = useIsOnline();
  const file = useMutation(addRecipesToCollectionMutation(queryClient, householdId));
  const { notifyStale } = useStaleToast(householdId);

  const [query, setQuery] = useState("");
  /**
   * An **array**, not a `Set`: tap order is append order, and the server files
   * `recipeIds` in the order it receives them (§5). Ticking A then B should put
   * A above B on the shelf.
   */
  const [picked, setPicked] = useState<string[]>([]);
  /** Ids the server refused because the shelf is published and they are not (§2.4). */
  const [blocked, setBlocked] = useState<string[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [reauthOpen, setReauthOpen] = useState(false);
  /** True while the combo is publishing the refused ids on the way in. */
  const [publishing, setPublishing] = useState(false);

  const filed = new Set(collection.recipeIds);
  const candidates = useMemo(
    () =>
      searchRows(
        [...recipes].sort((a, b) => a.title.localeCompare(b.title)),
        query,
      ),
    [recipes, query],
  );
  const blockedTitles = recipes.filter((row) => blocked.includes(row.recipeId)).map((row) => row.title);

  function close() {
    onOpenChange(false);
    setQuery("");
    setPicked([]);
    setBlocked([]);
    setFailed(null);
  }

  function toggle(recipeId: string, checked: boolean) {
    setPicked((prev) => (checked ? [...prev, recipeId] : prev.filter((id) => id !== recipeId)));
  }

  /**
   * File the selection. `publishRecipeIds` is non-empty only on the second pass,
   * after someone has read which recipes are private and pressed the combo.
   */
  async function onAdd(publishRecipeIds?: string[]) {
    if (picked.length === 0) return;
    setBlocked([]);
    setFailed(null);
    if (publishRecipeIds?.length) setPublishing(true);
    try {
      const result = await file.mutateAsync({ collectionId: collection.id, recipeIds: picked, publishRecipeIds });
      // The refusal *resolves* rather than throwing, so the optimistic patch is
      // not rolled back by `onError` — `onSettled`'s invalidation corrects the
      // list, and the sheet stays open holding the reason (port note, M1).
      if (!result.ok) {
        if (result.reason === "recipes_unpublished") setBlocked(result.recipeIds);
        else if (result.reason === "scope_error") setReauthOpen(true);
        else setFailed("Publishing is switched off right now. Nothing was filed.");
        return;
      }
      // The entries saved; `stale` is the publisher's copy of the shelf being
      // behind, which is a notice with a retry rather than a failed add.
      if (result.stale) notifyStale(collection);
      close();
    } catch {
      // A thrown error IS rolled back by the mutation's `onError`, so the shelf
      // behind the sheet is already correct; all that is owed is the reason.
      setFailed("That didn’t save. Nothing was filed — try again.");
    } finally {
      setPublishing(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <SheetContent side="bottom" showCloseButton={false} className="max-h-[88svh] gap-0 p-0 data-[side=bottom]:rounded-t-xl">
        <SheetHeader className="flex-none border-b-2 border-border px-4 py-3">
          <SheetTitle className="display-title text-lg">Add recipes</SheetTitle>
          <SheetDescription>
            Pick what goes on <span className="font-semibold text-foreground">{collection.name}</span>. They’re filed in the order you tick them.
          </SheetDescription>
          <div className="mt-1.5 flex h-11 items-center gap-1.5 rounded-lg border-2 border-border bg-background px-3">
            <BookOpenText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${recipes.length} recipe${recipes.length === 1 ? "" : "s"}`}
              aria-label="Search your box"
              className="min-w-0 flex-1 border-0 bg-transparent text-sm font-medium text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
            />
          </div>
        </SheetHeader>

        {candidates.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-6 py-10 text-center">
            <UtensilsCrossed className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="m-0 text-[0.8125rem] font-bold text-foreground">{recipes.length === 0 ? "Your box is empty" : "Nothing matches that."}</p>
            <p className="m-0 text-xs text-pretty text-muted-foreground">
              {recipes.length === 0 ? "Add a recipe to your box first — a shelf holds recipes you already keep." : "Clear the search to see the rest of your box."}
            </p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
            {candidates.map((row) => {
              const already = filed.has(row.recipeId);
              const refused = blocked.includes(row.recipeId);
              return (
                <CheckboxRow
                  key={row.recipeId}
                  size="default"
                  tone="selection"
                  // Two lines of 13/11px type plus padding clears 44px on its
                  // own; the floor keeps it true if the type scale moves.
                  className={refused ? "min-h-11 border-dashed border-destructive/40" : "min-h-11"}
                  checked={already || picked.includes(row.recipeId)}
                  // An already-filed recipe is state, not a choice: unticking it
                  // here would mean "unfile", and unfiling lives in the edit
                  // sheet's member list where it is one deliberate control.
                  disabled={already}
                  title={online ? undefined : OFFLINE_WRITE_HINT}
                  meta={already ? "Filed" : row.totalTimeDisplay}
                  onCheckedChange={(checked) => {
                    if (!online || already) return;
                    toggle(row.recipeId, checked);
                  }}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate font-semibold">{row.title}</span>
                    {row.unpublished && <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Private — not published" />}
                  </span>
                  <span className="block truncate text-xs font-medium text-muted-foreground">{row.sourceLabel}</span>
                </CheckboxRow>
              );
            })}
          </div>
        )}

        <SheetFooter className="flex-none border-t-2 border-border">
          {blockedTitles.length > 0 && (
            <div className="flex flex-col gap-2 rounded-lg border-2 border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-foreground" role="status">
              <p className="m-0">
                {collection.name} is published, so it can only hold published recipes: {blockedTitles.join(", ")}.
              </p>
              <Button
                variant="outline"
                className="h-11 w-full"
                disabled={!online || file.isPending}
                title={online ? undefined : OFFLINE_WRITE_HINT}
                onClick={() => void onAdd(blocked)}
              >
                {publishing ? "Publishing…" : `Publish ${blocked.length === 1 ? "recipe" : `${blocked.length} recipes`} & add`}
              </Button>
            </div>
          )}
          {failed && (
            <p className="m-0 rounded-lg border-2 border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-foreground" role="status">
              {failed}
            </p>
          )}
          <Button
            size="lg"
            className="h-11 w-full"
            disabled={picked.length === 0 || !online || file.isPending}
            title={online ? undefined : OFFLINE_WRITE_HINT}
            onClick={() => void onAdd()}
          >
            {file.isPending ? "Filing…" : picked.length === 0 ? "Pick some recipes" : `Add ${picked.length} recipe${picked.length === 1 ? "" : "s"}`}
          </Button>
          <Button variant="ghost" size="lg" className="h-11 w-full" onClick={close}>
            Cancel
          </Button>
        </SheetFooter>

        {/* The combo publishes recipes, so an under-scoped grant refuses it the
          same way the recipe detail's own publish button does. */}
        <AtprotoReauthDialog open={reauthOpen} onOpenChange={setReauthOpen} touch />
      </SheetContent>
    </Sheet>
  );
}
