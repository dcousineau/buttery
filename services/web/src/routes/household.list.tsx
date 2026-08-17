import { createFileRoute, useRouter } from "@tanstack/react-router";
import { startTransition, useCallback, useEffect, useOptimistic, useRef, useState } from "react";
import { BookOpenText, CalendarRange, Check, Trash2 } from "lucide-react";
import { type GroceryItemRow, type GroceryListPayload, clearCheckedGroceryItems, getGroceryList, removeGroceryItem, toggleGroceryItem, updateGroceryItem } from "#/server/grocery";
import { requireActiveHousehold } from "#/server/household/onboarding";
import { todayIn } from "#/lib/plan/week";
import { AddPreviewDialog, type AddPreviewRequest } from "#/components/grocery/AddPreviewDialog";
import { RecipePickerDialog } from "#/components/grocery/RecipePickerDialog";
import { GroceryList } from "#/components/grocery/GroceryList";
import { ManualItemInput } from "#/components/grocery/ManualItemInput";
import { listCounts, visibleItems, withCheckedCleared, withItemChecked, withItemEdited, withItemRemoved } from "#/components/grocery/optimistic";
import { ConfirmDialog } from "#/components/ConfirmDialog";
import { Button } from "#/components/ui/button";
import { Toast, ToastViewport, useToasts } from "#/components/ui/toast";
import { seo } from "#/lib/seo";

/**
 * The household shopping list (`/household/list`).
 *
 * One running list per household (D1), always grouped by aisle, read and written
 * the way the meal planner is: optimistic patch, `router.invalidate()`,
 * refetch-on-focus, last-write-wins per item (D12). Two people in the same store
 * on two phones is the normal case, not the edge one.
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
  loader: async () => {
    await requireActiveHousehold();
    return await getGroceryList();
  },
  head: () => ({ meta: seo({ title: "Shopping list · Buttery", description: "One running list for your household, consolidated and grouped by aisle." }) }),
  component: GroceryListPage,
});

function GroceryListPage() {
  const loaded = Route.useLoaderData();
  const router = useRouter();
  const { toasts, push, dismiss, pauseAll, resumeAll } = useToasts(4000);

  /**
   * The optimistic overlay: the list as it should already look, laid over the
   * one the loader last returned.
   *
   * `useOptimistic` rather than ordinary state, for the reason the planner
   * documents at length: React drops the optimistic value in the same commit
   * that delivers the settled payload, while a hand-cleared `setState(null)`
   * outranks the router's pending transition and paints one frame of pre-write
   * data. In a store that frame reads as "my tap didn't take".
   */
  const [list, applyPatch] = useOptimistic(loaded, (current: GroceryListPayload, patch: (list: GroceryListPayload) => GroceryListPayload) => patch(current));
  const [announcement, setAnnouncement] = useState("");
  const [addRequest, setAddRequest] = useState<AddPreviewRequest | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
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
   * D12's answer to "two people shopping at once": no sockets, just look again
   * when you come back. Coming back to the tab is the moment a stale list is
   * most likely and least expensive to fix. Throttled so alt-tabbing does not
   * hammer the loader.
   */
  useEffect(() => {
    let last = 0;
    function refresh() {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last < 10_000) return;
      last = now;
      void router.invalidate();
    }
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);

  /** "The fresh list is now on screen" — the signal `run` ends its transition on. */
  const loaderCommitted = useRef<(() => void) | null>(null);
  useEffect(() => {
    loaderCommitted.current?.();
    loaderCommitted.current = null;
  }, [loaded]);

  const whenLoaderCommits = useCallback(
    () =>
      new Promise<void>((resolve) => {
        loaderCommitted.current?.();
        loaderCommitted.current = resolve;
        // Nothing guarantees a *new* payload — a no-op write, or a load the
        // router dedupes, can leave `loaded` untouched — and a transition that
        // never ends would pin the optimistic list there for good.
        setTimeout(() => {
          if (loaderCommitted.current !== resolve) return;
          loaderCommitted.current = null;
          resolve();
        }, 1000);
      }),
    [],
  );

  /**
   * One shape for every write: paint, send, then reconcile. Lifted verbatim from
   * `/household/plan` — the two routes have the same concurrency story, and a
   * second dialect of it would be a second place for the flicker to come back.
   *
   * Failure does not un-apply the patch; the transition ending drops it. Only
   * the loader knows what the list really contains, and after a failed write it
   * is also the only thing that knows whether the write half-happened.
   */
  const run = useCallback(
    (options: { optimistic?: (list: GroceryListPayload) => GroceryListPayload; action: () => Promise<unknown>; toast?: string; announce?: string }) => {
      startTransition(async () => {
        if (options.optimistic) applyPatch(options.optimistic);
        const settled = whenLoaderCommits();
        try {
          await options.action();
          if (options.toast) push({ variant: "success", title: options.toast });
          if (options.announce) setAnnouncement(options.announce);
        } catch (error) {
          push({ variant: "destructive", title: error instanceof Error ? error.message : "That didn't save. Try again." });
        } finally {
          await router.invalidate();
          await settled;
        }
      });
    },
    [applyPatch, push, router, whenLoaderCommits],
  );

  const items = visibleItems(list);
  const { remaining, checked } = listCounts(items);

  function toggleItem(item: GroceryItemRow, isChecked: boolean) {
    run({
      optimistic: (current) => withItemChecked(current, item.id, isChecked),
      action: () => toggleGroceryItem({ data: { itemId: item.id, checked: isChecked } }),
      announce: isChecked ? `${item.displayName} in the cart` : `${item.displayName} back on the list`,
    });
  }

  function editItem(item: GroceryItemRow, patch: { displayName?: string; quantity?: number | null }) {
    // Nothing changed — an edit form submitted unedited is not a write.
    if (patch.displayName === undefined && patch.quantity === undefined) return;
    run({
      optimistic: (current) => withItemEdited(current, item.id, patch),
      action: () => updateGroceryItem({ data: { itemId: item.id, ...patch } }),
      toast: "Saved",
    });
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
    run({
      optimistic: (current) => withItemRemoved(current, item.id),
      action: () => removeGroceryItem({ data: { itemId: item.id } }),
      toast: `${item.displayName} removed`,
      announce: `${item.displayName} removed from the list`,
    });
  }

  function clearChecked() {
    setConfirmClear(false);
    run({
      optimistic: withCheckedCleared,
      action: () => clearCheckedGroceryItems(),
      toast: checked === 1 ? "1 item cleared" : `${checked} items cleared`,
      announce: "Checked items cleared",
    });
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
                <Button
                  variant="outline"
                  size="sm"
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
                <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                  <BookOpenText data-icon="inline-start" aria-hidden="true" />
                  Add recipes
                </Button>
                {checked > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setConfirmClear(true)}>
                    <Trash2 data-icon="inline-start" aria-hidden="true" />
                    Clear checked
                  </Button>
                )}
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
              onAdded={(text, result) => {
                // No optimistic row: the aisle, the parsed amount and whether it
                // merged are the lexicon's answers, not the client's.
                push({ variant: "success", title: result.merged ? `${text} merged into the list` : `${text} added` });
                setAnnouncement(`${text} added to the list`);
                void router.invalidate();
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
              <GroceryList items={items} onToggle={toggleItem} onEdit={editItem} onRemove={askRemove} />
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
          void router.invalidate();
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
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear the checked items?"
        description={`${checked === 1 ? "One item is" : `${checked} items are`} in the cart. Clearing removes them from the list for everyone — the recipes they came from are untouched.`}
        confirmLabel="Clear checked"
        destructive
        onConfirm={clearChecked}
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
