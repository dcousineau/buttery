import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { BookOpenText, CalendarRange, Check, EllipsisVertical, ListX, Trash2 } from "lucide-react";
import { type GroceryItemRow, groceryListQuery, grocerySweepMutation, keys, removeGroceryItemMutation, toggleGroceryItemMutation, updateGroceryItemMutation } from "#/lib/api";
import { ensureActiveHousehold } from "#/lib/offline/active-household";
import { OFFLINE_WRITE_HINT, useIsOnline } from "#/lib/offline/use-online";
import { todayIn } from "#/lib/plan/week";
import { AddPreviewDialog, type AddPreviewRequest } from "#/components/grocery/AddPreviewDialog";
import { RecipePickerDialog } from "#/components/grocery/RecipePickerDialog";
import { GroceryList } from "#/components/grocery/GroceryList";
import { ManualItemInput } from "#/components/grocery/ManualItemInput";
import { listCounts, visibleItems } from "#/components/grocery/optimistic";
import { ConfirmDialog } from "#/components/ConfirmDialog";
import { Button } from "#/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "#/components/ui/dropdown-menu";
import { Toast, ToastViewport, useToasts } from "#/components/ui/toast";
import { seo } from "#/lib/seo";

/**
 * The household shopping list (`/household/list`).
 *
 * One running list per household (D1), always grouped by aisle, read and written
 * the way the meal planner is: optimistic patch, refetch-on-focus,
 * last-write-wins per item (D12). Two people in the same store on two phones is
 * the normal case, not the edge one.
 *
 * **The best offline surface in the app (offline plan §4.1).** It is read in a
 * store, on a phone, on the one network the household does not control. Reads
 * come from `groceryListQuery`, so the list is persisted to IndexedDB and paints
 * from cache with no network at all; writes stay online-only in M1 and disable
 * with an offline affordance. M2 is what queues the check-offs — and it can
 * without a single server change, because `toggleGroceryItem` is already an
 * absolute `{itemId, checked}` write and therefore replay-safe by shape (§2.5).
 *
 * The optimistic machinery is Query's now, not `useOptimistic` + a transition.
 * The long comments this file used to carry about flicker — a `setState(null)`
 * outranking the router's pending transition and painting one frame of pre-write
 * data — describe a problem that does not arise here: the patched value lives in
 * the query cache, so there is no window in which the settled payload and the
 * dropped patch disagree. `onMutate`/`onError`/`onSettled` in
 * `src/lib/api/mutations.ts` is the whole lifecycle, once, for every write.
 *
 * Grouping has no toggle and no search param. The plan gave D8 a flat-list
 * escape hatch for when the lexicon files something in the wrong aisle; the
 * layout switch turned out to cost more than the miscategorisations it hedged
 * against, so grouping is unconditional and a wrong aisle is fixed by renaming
 * the line.
 *
 * `/household/*` is an "app view" (see `AppShell`): `main` is pinned to the
 * viewport and this route owns its own scroll container, so the header bar and
 * the add field stay put while the aisles scroll under them — which is the only
 * layout that works with a basket in the other hand.
 *
 * Everything on the page shares one centred `max-w-3xl` column — the same width
 * `MisePhase` gives the cook-mode checklist, the app's only other big list of
 * things to tick off. Wider than that and a 3-word row leaves the checkbox and
 * its trash button at opposite ends of a 1200px screen. The strips themselves
 * stay full-bleed, so on a phone the rows run edge to edge and only their own
 * padding insets the text.
 */

/**
 * The half of the remove copy that depends on where the row came from.
 *
 * "Remove" means "off the shopping list", never "out of the recipe" — the same
 * distinction "Clear checked" draws, worded to match it. A hand-typed row came
 * from no recipe, so it gets no clause rather than a reassurance about a recipe
 * that does not exist.
 */
function recipeCaveat(item: GroceryItemRow): string {
  const recipes = new Set(item.sources.map((source) => source.title).filter(Boolean));
  if (recipes.size === 1) return " — the recipe it came from is untouched";
  if (recipes.size > 1) return " — the recipes it came from are untouched";
  return "";
}

export const Route = createFileRoute("/household/list")({
  beforeLoad: async () => ({ ...(await ensureActiveHousehold()) }),
  loader: ({ context }) => context.queryClient.ensureQueryData(groceryListQuery(context.householdId)),
  head: () => ({ meta: seo({ title: "Shopping list · Buttery", description: "One running list for your household, consolidated and grouped by aisle." }) }),
  component: GroceryListPage,
});

function GroceryListPage() {
  const { householdId } = Route.useRouteContext();
  const queryClient = useQueryClient();
  // The hook, not the loader's return value: an unobserved query gets no
  // refetch-on-reconnect, no invalidation and no gc protection — the exact
  // machinery an aisle with no signal depends on (§4.1).
  const { data: list } = useSuspenseQuery(groceryListQuery(householdId));
  const online = useIsOnline();
  const { toasts, push, dismiss, pauseAll, resumeAll } = useToasts(4000);

  const [announcement, setAnnouncement] = useState("");
  const [addRequest, setAddRequest] = useState<AddPreviewRequest | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmClearPurchased, setConfirmClearPurchased] = useState(false);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  /**
   * The row the trash button asked to remove, and whether its confirm is open.
   *
   * Two pieces of state rather than one nullable row: the dialog fades out over
   * 150ms, and clearing the row on close would blank the copy — including the
   * item's name — mid-animation. Keeping the row until the *next* remove is
   * requested lets the dialog animate out still saying what it was about.
   */
  const [removeTarget, setRemoveTarget] = useState<GroceryItemRow | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  /**
   * Every write on this page, as Query mutations. The optimistic patch, the
   * rollback and the invalidation all live in `src/lib/api/mutations.ts`; what
   * stays here is what the *page* owns — the toast and the live-region wording,
   * which are copy, not cache.
   *
   * D12's "look again when you come back" is gone from this file entirely: it is
   * `refetchOnWindowFocus` on the QueryClient now, throttled by `staleTime`
   * (10s for this query) rather than by a hand-rolled timestamp.
   */
  const toggle = useMutation(toggleGroceryItemMutation(queryClient, householdId));
  const edit = useMutation(updateGroceryItemMutation(queryClient, householdId));
  const remove = useMutation(removeGroceryItemMutation(queryClient, householdId));
  const sweep = useMutation(grocerySweepMutation(queryClient, householdId));

  /** The one failure message every write on this page shares. */
  function onWriteFailed(error: unknown) {
    push({ variant: "destructive", title: error instanceof Error ? error.message : "That didn't save. Try again." });
  }

  /** A write landed and there is nothing on this page left to patch. */
  async function refreshList() {
    await queryClient.invalidateQueries({ queryKey: keys.household.grocery(householdId) });
  }

  const items = visibleItems(list);
  const { remaining, checked } = listCounts(items);

  function toggleItem(item: GroceryItemRow, isChecked: boolean) {
    setAnnouncement(isChecked ? `${item.displayName} in the cart` : `${item.displayName} back on the list`);
    toggle.mutate({ itemId: item.id, checked: isChecked }, { onError: onWriteFailed });
  }

  function editItem(item: GroceryItemRow, patch: { displayName?: string; quantity?: number | null }) {
    // Nothing changed — an edit form submitted unedited is not a write.
    if (patch.displayName === undefined && patch.quantity === undefined) return;
    edit.mutate(
      { itemId: item.id, ...patch },
      {
        onSuccess: () => push({ variant: "success", title: "Saved" }),
        onError: onWriteFailed,
      },
    );
  }

  /**
   * The trash button only *asks*. Removing is the one action on a row that
   * cannot be undone by tapping again — checking off is reversible, an edit is
   * re-editable — and it sits a thumb's width from the checkbox on a phone, so
   * it goes through the same confirm "Clear checked" uses.
   */
  function askRemove(item: GroceryItemRow) {
    setRemoveTarget(item);
    setConfirmRemove(true);
  }

  /** The confirmed remove. Still optimistic — the confirm sits in front of it. */
  function removeItem(item: GroceryItemRow) {
    setConfirmRemove(false);
    setAnnouncement(`${item.displayName} removed from the list`);
    remove.mutate(
      { itemId: item.id },
      {
        onSuccess: () => push({ variant: "success", title: `${item.displayName} removed` }),
        onError: onWriteFailed,
      },
    );
  }

  /**
   * The end-of-trip sweep: what is in the cart comes off the list.
   *
   * A soft delete on the server — the rows are kept as history — which is
   * invisible from here: a swept row is as gone from the list either way, so the
   * optimistic patch is the same one a real delete would use.
   */
  function clearPurchased() {
    setConfirmClearPurchased(false);
    setAnnouncement("Purchased items cleared");
    sweep.mutate(
      { kind: "purchased" },
      {
        onSuccess: () => push({ variant: "success", title: checked === 1 ? "1 item cleared" : `${checked} items cleared` }),
        onError: onWriteFailed,
      },
    );
  }

  /** The same sweep, widened: the list goes back to empty, checked or not. */
  function clearAll() {
    setConfirmClearAll(false);
    setAnnouncement("The list was cleared");
    sweep.mutate(
      { kind: "all" },
      {
        onSuccess: () => push({ variant: "success", title: items.length === 1 ? "1 item cleared" : `${items.length} items cleared` }),
        onError: onWriteFailed,
      },
    );
  }

  /** The one that actually deletes — swept rows included. */
  function deleteAll() {
    setConfirmDeleteAll(false);
    setAnnouncement("The whole list was deleted");
    sweep.mutate({ kind: "delete" }, { onSuccess: () => push({ variant: "success", title: "List deleted" }), onError: onWriteFailed });
  }

  return (
    <>
      <div className="flex h-[calc(100svh-var(--header-height,4rem))] min-h-0 w-full">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* The title and the actions are two wrap rows on a phone, not one:
            `basis-full` hands the heading its own line so a four-word h1 and
            three buttons stop fighting over 390px. From `sm` up they share a
            line again and the actions ride the right edge. */}
          <div className="flex flex-none border-b-2 border-border bg-card px-3 py-2.5 md:px-4">
            <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-2.5 gap-y-2">
              <div className="flex min-w-0 basis-full flex-wrap items-baseline gap-x-2 gap-y-0.5 sm:flex-1 sm:basis-auto">
                <h1 className="display-title m-0 text-base leading-[1.1] md:text-[1.625rem]">Shopping list</h1>
                <p className="m-0 text-xs font-semibold text-muted-foreground">
                  {items.length === 0 ? "Nothing on it yet" : `${remaining} to get${checked > 0 ? ` · ${checked} in the cart` : ""}`}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto md:gap-2">
                {/* The list is a household's, not a week's (D1), so pulling a plan
                week in is an action the list itself offers — not something you
                have to go back to the planner to do. The server snaps the date
                to the household's own week start. */}
                {/* Every "add" here reads the household's recipes and the food
                  lexicon server-side, so there is nothing to do offline but
                  say so. The list itself stays fully readable. */}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!online}
                  title={online ? undefined : OFFLINE_WRITE_HINT}
                  onClick={() => setAddRequest({ planWeek: todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone), label: "This week's plan" })}
                >
                  <CalendarRange data-icon="inline-start" aria-hidden="true" />
                  Add this week
                </Button>
                {/* D3's fourth source: several boxed recipes at once. Picking is a
                separate step from confirming — the picker answers "which
                recipes", the preview answers "which rows", and collapsing them
                into one dialog would ask both questions before either has an
                answer. */}
                <Button variant="outline" size="sm" disabled={!online} title={online ? undefined : OFFLINE_WRITE_HINT} onClick={() => setPickerOpen(true)}>
                  <BookOpenText data-icon="inline-start" aria-hidden="true" />
                  Add recipes
                </Button>
                {/* Every way of emptying the list lives behind one triple-dot:
                they are rare, they are irreversible from the UI, and none of
                them deserves a permanent button beside the two you press every
                week.

                The trigger is always here — a control that comes and goes is one
                you have to hunt for — and so is every item in it. Items disable
                rather than disappear for the same reason: a menu whose contents
                move around between openings is a menu you have to read every
                time. On an empty list the two sweeps are simply inert; the
                delete is not, because a swept list is not an empty one. */}
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button variant="outline" size="icon-sm" aria-label="List actions" title="List actions">
                        <EllipsisVertical aria-hidden="true" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end" className="min-w-52">
                    <DropdownMenuItem disabled={checked === 0 || !online} onClick={() => setConfirmClearPurchased(true)}>
                      <Check aria-hidden="true" />
                      {checked > 0 ? `Clear purchased (${checked})` : "Clear purchased"}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={items.length === 0 || !online} onClick={() => setConfirmClearAll(true)}>
                      <ListX aria-hidden="true" />
                      Clear all
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {/* The only one that is not a sweep. It gets the destructive
                    styling the other two deliberately do not: they keep what
                    they take.

                    It is also the only one that stays enabled on an empty list,
                    because "empty" here means "nothing visible": after a sweep
                    the cleared rows are still in the database and this is the
                    one action that reclaims them. Disabling it then would leave
                    them unreachable forever. On a genuinely empty list it is a
                    server-side no-op. */}
                    <DropdownMenuItem variant="destructive" disabled={!online} onClick={() => setConfirmDeleteAll(true)}>
                      <Trash2 aria-hidden="true" />
                      Delete everything
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>

          {/* Pinned above the scroll area: adding four things in a row is how
            this field actually gets used, and scrolling back to the top between
            each one is not something a hand holding a basket wants to do.

            It gets its own top padding: without one the field sat flush against
            the header's bottom border and the two zones read as a single
            overlapping block. */}
          <div className="flex-none border-b-2 border-border bg-card px-3 py-2.5 md:px-4">
            <ManualItemInput
              className="mx-auto w-full max-w-3xl"
              disabled={!online}
              onAdded={(text, result) => {
                // No optimistic row: the aisle, the parsed amount and whether it
                // merged are the lexicon's answers, not the client's.
                push({ variant: "success", title: result.merged ? `${text} merged into the list` : `${text} added` });
                setAnnouncement(`${text} added to the list`);
                void refreshList();
              }}
              onError={(message) => push({ variant: "destructive", title: message })}
            />
          </div>

          {/* Announces what changed on the list. Toasts carry the same news
            visually, but their viewport is also used for failures — this stays
            the one place a screen reader hears the list itself change. */}
          <p aria-live="polite" className="sr-only">
            {announcement}
          </p>

          {/* No horizontal padding on the scrollport: the rows are full-bleed
            slats and own their own inset, so on a phone the divider runs edge to
            edge and only the text is inset. */}
          <div className="flex min-h-0 flex-1 flex-col overflow-auto pb-8">
            <div className="mx-auto w-full max-w-3xl">
              <GroceryList items={items} onToggle={toggleItem} onEdit={editItem} onRemove={askRemove} writable={online} />
            </div>
          </div>
        </section>
      </div>

      <RecipePickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPicked={(recipes) => {
          setPickerOpen(false);
          setAddRequest({ recipes, label: recipes.length === 1 ? "1 recipe" : `${recipes.length} recipes` });
        }}
      />

      <AddPreviewDialog
        request={addRequest}
        onClose={() => setAddRequest(null)}
        onCommitted={(result) => {
          const total = result.added + result.merged;
          push({
            variant: "success",
            title: total === 0 ? "Nothing to add" : `${total} ${total === 1 ? "item" : "items"} on the list${result.merged > 0 ? ` · ${result.merged} merged` : ""}`,
          });
          setAnnouncement(`${total} added to the list`);
          void refreshList();
        }}
        onError={(message) => push({ variant: "destructive", title: message })}
      />

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={removeTarget ? `Remove ${removeTarget.displayName}?` : "Remove this item?"}
        description={`This takes it off the list for everyone${removeTarget ? recipeCaveat(removeTarget) : ""}.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => removeTarget && removeItem(removeTarget)}
      />

      <ConfirmDialog
        open={confirmClearPurchased}
        onOpenChange={setConfirmClearPurchased}
        title="Clear the purchased items?"
        description={`${checked === 1 ? "One item is" : `${checked} items are`} in the cart. Clearing takes them off the list for everyone and keeps them as history — the recipes they came from are untouched.`}
        confirmLabel="Clear purchased"
        onConfirm={clearPurchased}
      />

      <ConfirmDialog
        open={confirmClearAll}
        onOpenChange={setConfirmClearAll}
        title="Clear the whole list?"
        description={`${items.length === 1 ? "The one item on the list comes off" : `All ${items.length} items come off`} — checked or not, for everyone. They are kept as history rather than deleted, and the recipes they came from are untouched.`}
        confirmLabel="Clear all"
        onConfirm={clearAll}
      />

      <ConfirmDialog
        open={confirmDeleteAll}
        onOpenChange={setConfirmDeleteAll}
        title="Delete everything on the list?"
        description={`${items.length === 0 ? "Everything already cleared goes" : items.length === 1 ? "The one item on the list goes, along with anything already cleared" : `All ${items.length} items go, along with anything already cleared`} — this is the one that does not keep them. The recipes they came from are untouched, so you can add them back.`}
        confirmLabel="Delete everything"
        destructive
        onConfirm={deleteAll}
      />

      <ToastViewport position="bottom-center" onMouseEnter={pauseAll} onMouseLeave={resumeAll} onFocusCapture={pauseAll} onBlurCapture={resumeAll}>
        {toasts.map((toast) => (
          <Toast key={toast.id} variant={toast.variant} title={toast.title} onClose={() => dismiss(toast.id)}>
            {toast.variant === "success" && <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
          </Toast>
        ))}
      </ToastViewport>
    </>
  );
}
