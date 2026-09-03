import { useId, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpenText, EyeOff, UtensilsCrossed } from "lucide-react";
import { addRecipesToCollectionMutation, type CollectionSummary, type HouseholdRecipeRow } from "#/lib/api";
import { OFFLINE_WRITE_HINT, useIsOnline } from "#/lib/offline/use-online";
import { AtprotoReauthDialog } from "#/components/AtprotoReauthDialog";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "#/components/ui/sheet";
import { RecipeSlat, RecipeSlatAction, RecipeSlatAside, RecipeSlatBody, RecipeSlatList, RecipeSlatMeta, RecipeSlatTitle } from "#/components/recipes/RecipeSlat";
import { SourceIcon } from "#/components/recipes/SourceIcon";
import { cn } from "#/lib/utils";
import { searchRows } from "./scope";
import { useStaleToast } from "./use-stale-toast";

/**
 * "Add recipes" — many recipes onto one collection, on a phone (§7).
 *
 * The other half of mobile's filing story. `FileRecipeSheet` starts from a
 * recipe ("which collections does this belong in?"); this starts from the
 * collection ("what goes in here?"), which is the question you have with an
 * empty collection in front of you and thirty recipes in the box. On a desktop
 * that job belongs to dragging a ledger row onto a collection row; **mobile has
 * no drag** (§7), so it is this.
 *
 * Unlike the tick-to-save picker, this one **batches**: a selection, then one
 * `addRecipesToCollection` call. Filing fifteen recipes one request at a time
 * would be fifteen optimistic patches racing one another's `onSettled`
 * invalidation, and the server appends in the order it is given — so one call
 * is also the only way the resulting collection order matches the order they
 * were ticked.
 *
 * ## The rows are ledger slats, not cards
 *
 * This list is *the recipe box, seen through a filing question*, so it is drawn
 * with the same `RecipeSlat` the box ledger uses: flush full-bleed bars, a
 * hairline between neighbours, no per-row border or shadow. A gapped stack of
 * outlined cards reads as N separate objects to compare one at a time; a column
 * of slats reads as one ledger to scan, and scanning thirty recipes for the six
 * that belong here is the entire job of this sheet. Matching the ledger also
 * means a recipe looks the same in both places — same thumbnail tile, same
 * title with its state icons, same source line, same trailing time.
 *
 * The slat's leading-control slot carries the tick: a bare `Checkbox` **outside**
 * `RecipeSlatAction`, exactly as the import review list composes it. The action
 * itself renders as a `<label htmlFor>` rather than the default button, which is
 * what keeps the *whole row* the hit target without inventing a second control
 * for one checkbox — the same trade `CheckboxRow` makes, minus the card.
 *
 * Rows are ≥44px (§7) and two-line: a title alone is not enough to tell two
 * "Chana masala"s apart, and the source line is what does it in the ledger too.
 *
 * **The refusal has an escape hatch.** A published collection cannot hold a
 * private recipe (§2.4), and a batch is the one place that can be true of
 * several recipes at once — so the footer's refusal grows a single "Publish N &
 * add" that re-sends the same selection with those ids in `publishRecipeIds`,
 * and every refused row is tinted so the list says which ones it means. The
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
  /** Prefix for the per-row checkbox ids the row labels point at. */
  const rowIdPrefix = useId();

  const [query, setQuery] = useState("");
  /**
   * An **array**, not a `Set`: tap order is append order, and the server files
   * `recipeIds` in the order it receives them (§5). Ticking A then B should put
   * A above B in the collection.
   */
  const [picked, setPicked] = useState<string[]>([]);
  /** Ids the server refused because the collection is published and they are not (§2.4). */
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
      // The entries saved; `stale` is the publisher's copy of the collection
      // being behind, which is a notice with a retry rather than a failed add.
      if (result.stale) notifyStale(collection);
      close();
    } catch {
      // A thrown error IS rolled back by the mutation's `onError`, so the
      // collection behind the sheet is already correct; all that is owed is the
      // reason.
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
            Pick what goes in <span className="font-semibold text-foreground">{collection.name}</span>. They’re filed in the order you tick them.
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
              {recipes.length === 0 ? "Add a recipe to your box first — a collection holds recipes you already keep." : "Clear the search to see the rest of your box."}
            </p>
          </div>
        ) : (
          <RecipeSlatList className="min-h-0 flex-1 overflow-auto">
            {candidates.map((row) => {
              const already = filed.has(row.recipeId);
              const ticked = already || picked.includes(row.recipeId);
              const refused = blocked.includes(row.recipeId);
              const checkId = `${rowIdPrefix}${row.recipeId}`;
              return (
                <RecipeSlat
                  key={row.recipeId}
                  // A ticked row takes the butter selection marker the ledger
                  // uses for its current row — membership is a standing fact, and
                  // this is the app's one row dialect for saying so.
                  selected={ticked}
                  // The slat's own padding plus a 44px tile already clears the
                  // touch floor; the explicit `min-h-11` (§7) keeps it true if
                  // the tile or the type scale ever moves.
                  className={cn("min-h-11", refused && "border-destructive/40 bg-destructive/10")}
                  title={online ? undefined : OFFLINE_WRITE_HINT}
                >
                  <Checkbox
                    id={checkId}
                    checked={ticked}
                    // An already-filed recipe is state, not a choice: unticking it
                    // here would mean "unfile", and unfiling lives in the edit
                    // sheet's member list where it is one deliberate control.
                    disabled={already}
                    onChange={(event) => {
                      if (!online || already) return;
                      toggle(row.recipeId, event.target.checked);
                    }}
                  />
                  {/* A label, not the slat's default button: the whole row is the
                    tick's hit target, and the row's own text is the tick's name. */}
                  <RecipeSlatAction render={<label htmlFor={checkId} />} className={cn("cursor-(--cursor-interactive)", already && "cursor-default")}>
                    {row.thumbUrl ? (
                      <img src={row.thumbUrl} alt="" className="size-11 flex-none rounded-sm border-2 border-border object-cover" loading="lazy" />
                    ) : (
                      <span className="grid size-11 flex-none place-content-center rounded-sm border-2 border-border bg-muted">
                        <UtensilsCrossed className="size-4 text-muted-foreground" aria-hidden="true" />
                      </span>
                    )}
                    <RecipeSlatBody>
                      <RecipeSlatTitle>
                        <span className="truncate">{row.title}</span>
                        {row.unpublished && <EyeOff className="size-3 shrink-0 text-muted-foreground" aria-label="Private — not published" />}
                      </RecipeSlatTitle>
                      <RecipeSlatMeta className="flex items-center gap-1">
                        <SourceIcon kind={row.sourceKind} className="size-[11px] shrink-0" />
                        <span className="truncate">{row.sourceLabel}</span>
                      </RecipeSlatMeta>
                    </RecipeSlatBody>
                    {(already || row.totalTimeDisplay) && <RecipeSlatAside>{already ? "Filed" : row.totalTimeDisplay}</RecipeSlatAside>}
                  </RecipeSlatAction>
                </RecipeSlat>
              );
            })}
          </RecipeSlatList>
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
        <AtprotoReauthDialog open={reauthOpen} onOpenChange={setReauthOpen} />
      </SheetContent>
    </Sheet>
  );
}
