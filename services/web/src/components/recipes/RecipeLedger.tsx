import { type DragEventHandler, type ReactNode, useMemo, useState } from "react";
import { Link, useRouteContext } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpenText, EyeOff, FolderLock, Plus, Star, Unlink, UtensilsCrossed } from "lucide-react";
import { type HouseholdRecipeRow, reorderCollectionRecipesMutation } from "#/lib/api";
import { useIsOnline } from "#/lib/offline/use-online";
import { Button } from "#/components/ui/button";
import { PaneBody, PaneHeader, PaneScroller } from "#/components/ui/pane";
import { DragHandle, DropLine, insertionPointAt } from "#/components/ui/drag-reorder";
import { CollectionsSheet } from "#/components/collections/CollectionsSheet";
import { ScopedLedgerHeader } from "#/components/collections/ScopedLedgerHeader";
import { dragCarries, RECIPE_DRAG_TYPE } from "#/components/collections/drag";
import { isDefaultScope, type LedgerScope, scopeLabel, scopeRows, searchRows } from "#/components/collections/scope";
import { useStaleToast } from "#/components/collections/use-stale-toast";
import { useDragHandle } from "#/lib/hooks/use-drag-source";
import { applyVisibleOrder, moveByKey, moveToInsertionPoint } from "#/lib/reorder";
import { cn } from "#/lib/utils";
import { RecipeSlat, RecipeSlatAction, RecipeSlatAside, RecipeSlatBody, RecipeSlatDetail, RecipeSlatList, RecipeSlatMeta, RecipeSlatTitle } from "./RecipeSlat";
import { SourceIcon } from "./SourceIcon";
import { Img } from "../ui/img";

/**
 * The recipe box ledger — now a **scoped** ledger (collections plan §7).
 *
 * What used to live in this file and no longer does: a `sort` dropdown and a "My
 * recipes" lock-chip. Both were subsumed by the collections tree's smart rows
 * (§2.2) — the chip was an unpublished-only filter under a misleading name, and
 * the sort was three options where the tree now offers four scopes plus every
 * collection the household has made. Sorting *within* a scope is deliberately
 * deferred (§2.2): a collection's order is manual and is the published array
 * order, so a sort control over it would have to mean "look, don't touch", and
 * that is a bigger conversation than a `<select>`.
 *
 * The ledger does not resolve its own scope. The layout route reads the URL and
 * hands the resolved `LedgerScope` down, because the same two search params also
 * drive the tree's highlight, and one resolver means the two columns cannot
 * disagree about what is selected.
 *
 * Search stays **local component state, owned by the route** and narrows *within*
 * the active scope — it is a lens, not a place, so it does not belong in the URL
 * beside the scope that is.
 *
 * ## Dragging, in two directions (§7)
 *
 * Every row is a drag source for its recipe (`application/x-buttery-recipe`), and
 * that one drag has two destinations:
 *
 * - **a collection row in the tree** — files the recipe there. Always available,
 *   in every scope, because "put this on that shelf" is the gesture the whole
 *   third column exists for.
 * - **the gap between two ledger rows** — but only while the ledger is scoped to
 *   a collection *and the search box is empty*. That order is the collection's
 *   entry order, which IS the published `recipes` array order, so it can only be
 *   rearranged while what is on screen is the order itself and not a filtered
 *   view of it.
 *
 * The grip changes shape with that second answer: a real keyboard control when
 * the list can be reordered (arrow keys move a row, `Home`/`End` send it to an
 * end), and a plain decorative grip otherwise — filing already has a keyboard
 * path through the collections picker, and a focusable button that does nothing
 * when pressed is worse than no button.
 *
 * **The reorder writes the whole order, never the rendered subset.** A scoped
 * ledger drops entries whose recipe has left the box, so what is on screen can be
 * a subsequence of `recipeIds`; `applyVisibleOrder` folds the new visible order
 * back into the full one, and the ids nobody could see keep their places.
 */

/** The ordered, searched rows for the active scope. */
function visibleRows(recipes: HouseholdRecipeRow[], scope: LedgerScope, query: string): HouseholdRecipeRow[] {
  return searchRows(scopeRows(recipes, scope), query);
}

export function RecipeLedger({
  recipes,
  scope,
  selectedId,
  query,
  onQueryChange,
  onAdd,
  collectionsOpen,
  onToggleCollections,
  collectionsPanelId,
  className,
}: {
  recipes: HouseholdRecipeRow[];
  /** Resolved by the layout route from `?scope=` / `?c=`. */
  scope: LedgerScope;
  selectedId: string | null;
  query: string;
  onQueryChange: (q: string) => void;
  onAdd: () => void;
  collectionsOpen: boolean;
  onToggleCollections: () => void;
  /** The collections column's DOM id, for the toggle's `aria-controls`. */
  collectionsPanelId: string;
  className?: string;
}) {
  const { householdId } = useRouteContext({ from: "/household/recipes" });
  const queryClient = useQueryClient();
  const online = useIsOnline();
  const { notifyStale } = useStaleToast(householdId);
  const reorder = useMutation({
    ...reorderCollectionRecipesMutation(queryClient, householdId),
    // The order IS the published array order (§2.6), so a reorder re-puts — and
    // the re-put can miss while the local rows still save (§5). Handled in the
    // mutation's own options rather than per-call, so the notice survives a
    // navigation away from the scope that made it (query-core drops per-call
    // callbacks once the observer has no listeners).
    onSuccess: (result) => {
      if (result.stale && collection) notifyStale(collection);
    },
  });

  const visible = useMemo(() => visibleRows(recipes, scope, query), [recipes, scope, query]);
  const visibleIds = useMemo(() => visible.map((r) => r.recipeId), [visible]);
  const boxEmpty = recipes.length === 0;
  const missing = scope.kind === "missing-collection";
  const emptyCollection = scope.kind === "collection" && scope.collection.recipeIds.length === 0;

  // The row being carried, and the gap it would land in — an *insertion point*
  // (0…visible.length), counted between rows rather than on them.
  const [dragging, setDragging] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  /** What the last reorder did, for people who cannot see the rows move. */
  const [moved, setMoved] = useState("");
  // One hook for every row: only one grip can be under the pointer, so only the
  // pressed row can arm itself.
  const { armed, handleProps, disarm } = useDragHandle();

  const collection = scope.kind === "collection" ? scope.collection : null;
  // Dragging is a write, and writes are online-only (§6) — offline there is no
  // grip at all, because a drag that cannot be saved should not start.
  const filable = online;
  const reorderable = collection !== null && query.trim() === "" && online && visible.length > 1;

  function endDrag() {
    setDragging(null);
    setDropAt(null);
    disarm();
  }

  /**
   * The one place a new order is written, from both the drag and the keyboard.
   *
   * `applyVisibleOrder` is the whole point: `nextVisible` is the order of the
   * rows on screen, and the write replaces the collection's entire entry order,
   * so the ids the scope dropped (a recipe that has left the box, and whose
   * unfiling has not reached this cache yet) have to be put back in their own
   * slots rather than silently deleted.
   */
  function commitOrder(nextVisible: string[], movedIndex: number) {
    if (!collection || nextVisible === visibleIds) return;
    reorder.mutate({ collectionId: collection.id, orderedRecipeIds: applyVisibleOrder(collection.recipeIds, nextVisible) });
    setMoved(`${visible[movedIndex].title} moved to ${nextVisible.indexOf(visibleIds[movedIndex]) + 1} of ${nextVisible.length}.`);
  }

  return (
    <div className={cn("flex min-h-0 flex-col border-border bg-background lg:w-[360px] lg:shrink-0 lg:border-r-2", className)}>
      <PaneScroller>
        {/* Below `md` the ledger gains a head of its own — the collections *sheet*
        trigger (collections plan §7), because the filter bar's toggle is
        `max-md:hidden` and a phone has no third column to toggle. It collapses
        on scroll while the filter bar below it stays: picking a shelf is
        something you do once, searching is something you do mid-scan. */}
        <CollectionsSheet householdId={householdId} scope={scope} className="md:hidden" />

        {/* Filter bar — deliberately compact, not a card. Pinned: the search field
        is the one control that has to be reachable from anywhere in the list. */}
        <PaneHeader className="flex gap-1.5 px-2.5 py-2">
          {/* The collections column's only toggle. It lives here rather than on the
          column itself because a collapsed column has nowhere to put a control. */}
          <Button
            variant="outline"
            size="sm"
            className="h-[30px] max-md:hidden"
            aria-expanded={collectionsOpen}
            aria-controls={collectionsPanelId}
            aria-label={collectionsOpen ? "Hide collections" : "Show collections"}
            onClick={onToggleCollections}
          >
            <FolderLock aria-hidden="true" />
          </Button>
          <div className="flex h-[30px] flex-1 items-center gap-1.5 rounded-lg border-2 border-border bg-background px-2.5">
            <BookOpenText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              // A scope that resolved to nothing has no name worth searching, so
              // the placeholder falls back to the box rather than saying "Search
              // Collection not found".
              placeholder={isDefaultScope(scope) || missing ? `Search ${recipes.length} recipe${recipes.length === 1 ? "" : "s"}` : `Search ${scopeLabel(scope)}`}
              aria-label="Search recipes"
              className="min-w-0 flex-1 border-0 bg-transparent text-[0.8125rem] font-medium text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
            />
          </div>
          <Button size="sm" className="h-[30px]" onClick={onAdd}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            Add
          </Button>
        </PaneHeader>

        {!isDefaultScope(scope) && <ScopedLedgerHeader scope={scope} count={visible.length} />}

        {/* Filter results are a status message — announce the count as the search /
         * scope narrows the list, so non-sighted users hear it change. */}
        <div className="sr-only" role="status" aria-live="polite">
          {boxEmpty
            ? ""
            : missing
              ? "This collection no longer exists."
              : visible.length === 0
                ? emptyCollection && !query
                  ? `${scopeLabel(scope)} is empty.`
                  : "No recipes match your filters."
                : `${visible.length} recipe${visible.length === 1 ? "" : "s"}.`}
        </div>

        {/* List */}
        <PaneBody>
          {boxEmpty ? (
            <EmptyBox onAdd={onAdd} />
          ) : missing ? (
            <MissingCollection />
          ) : visible.length === 0 ? (
            emptyCollection && !query ? (
              <EmptyCollection name={scopeLabel(scope)} />
            ) : (
              <EmptyFilter />
            )
          ) : (
            <RecipeSlatList
              // The reorder is read at the list, not at each row: the drop line
              // lands in the divider between two rows, and a drag read row-by-row
              // goes blind exactly there. A recipe on its way to a collection passes
              // over this list too — `reorderable` is what keeps a search result,
              // or a smart scope, from quietly rewriting a collection's order.
              onDragOver={(event) => {
                if (!reorderable || dragging === null || !dragCarries(event.dataTransfer, RECIPE_DRAG_TYPE)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropAt(insertionPointAt(event.currentTarget, event.clientY, "[data-ledger-row]"));
              }}
              onDragLeave={(event) => {
                // Only a departure from the list itself counts — crossing between
                // two rows fires dragleave too, and hiding the line there would
                // strobe it.
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(null);
              }}
              onDrop={(event) => {
                if (!reorderable || dragging === null || !dragCarries(event.dataTransfer, RECIPE_DRAG_TYPE)) return;
                event.preventDefault();
                if (dropAt !== null) commitOrder(moveToInsertionPoint(visibleIds, dragging, dropAt), dragging);
                endDrag();
              }}
            >
              {visible.map((r, index) => (
                <LedgerRow
                  key={r.recipeId}
                  row={r}
                  selected={r.recipeId === selectedId}
                  dragging={dragging === index}
                  draggable={filable && armed}
                  onDragStart={
                    filable
                      ? (event) => {
                          // One payload, two possible landings: `copy` onto a
                          // collection, `move` inside this list.
                          event.dataTransfer.effectAllowed = "copyMove";
                          event.dataTransfer.setData(RECIPE_DRAG_TYPE, r.recipeId);
                          setDragging(index);
                          if (reorderable) setDropAt(index);
                        }
                      : undefined
                  }
                  onDragEnd={filable ? endDrag : undefined}
                  handle={
                    filable ? (
                      <DragHandle
                        // Named per row: the alternative is one accessible name
                        // repeated down the whole ledger. It also names the job the
                        // grip actually does in this scope — only a collection
                        // scope has an order to rearrange.
                        label={reorderable ? `Reorder ${r.title}` : `Drag ${r.title} onto a collection`}
                        title={reorderable ? undefined : "Drag onto a collection to file it"}
                        onMove={reorderable ? (move) => commitOrder(moveByKey(visibleIds, index, move), index) : undefined}
                        onPointerDown={handleProps.onPointerDown}
                        className="max-md:hidden"
                      />
                    ) : undefined
                  }
                  dropLine={
                    dropAt === index ? (
                      <DropLine className="-top-[1.5px]" />
                    ) : dropAt === visible.length && index === visible.length - 1 ? (
                      // The one landing place no gap above a row can express.
                      <DropLine className="-bottom-[1.5px]" />
                    ) : undefined
                  }
                />
              ))}
            </RecipeSlatList>
          )}
        </PaneBody>
      </PaneScroller>

      {/* A reorder is invisible to anyone not watching the rows move, and the
        drop line is deliberately `aria-hidden`, so the move says itself here.
        Separate from the filter-count status above: they are two different
        pieces of news and one would overwrite the other. */}
      <p className="sr-only" role="status" aria-live="polite">
        {moved}
      </p>
    </div>
  );
}

/** The two `Add` affordances (filter bar + empty box) open the chooser modal. */

function LedgerRow({
  row,
  selected,
  handle,
  dropLine,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  row: HouseholdRecipeRow;
  selected: boolean;
  /** The grip, outside the hit target — a slat's one leading-control slot. */
  handle?: ReactNode;
  dropLine?: ReactNode;
  /** Armed by the grip only (`useDragHandle`), so a press on the row is still a click. */
  draggable?: boolean;
  dragging?: boolean;
  onDragStart?: DragEventHandler<HTMLLIElement>;
  onDragEnd?: DragEventHandler<HTMLLIElement>;
}) {
  return (
    <RecipeSlat
      selected={selected}
      data-ledger-row=""
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      // `relative` is what the drop line hangs off; without it the line would
      // position against the scrollport and draw in the wrong place entirely.
      className={cn("relative", dragging && "opacity-40")}
    >
      {dropLine}
      {handle}
      <RecipeSlatAction
        // `search: (prev) => prev` carries the active scope onto the detail
        // route (§7): opening a recipe from inside "Weeknights" keeps you inside
        // Weeknights, and the resulting URL deep-links to both at once.
        render={<Link to="/household/recipes/$id" params={{ id: row.recipeId }} search={(prev) => prev} />}
        // The row *is* a link to the current page when it's the selected one, so "page"
        // rather than a bare "true" — same state the butter marker paints.
        aria-current={selected ? "page" : undefined}
      >
        <Img
          src={row.thumbUrl}
          alt=""
          className="size-11 flex-none rounded-sm border-2 border-border object-cover"
          loading="lazy"
          fallback={
            <span className="grid size-11 flex-none place-content-center rounded-sm border-2 border-border bg-muted">
              <UtensilsCrossed className="size-4 text-muted-foreground" aria-hidden="true" />
            </span>
          }
        />
        <RecipeSlatBody>
          <RecipeSlatTitle>
            <span className="truncate">{row.title}</span>
            {row.unpublished && <EyeOff className="size-3 shrink-0 text-muted-foreground" aria-label="Private — not published" />}
            {row.favorite && <Star className="size-3 shrink-0 fill-primary text-primary" aria-label="Favorited" />}
            {row.unavailable && <Unlink className="size-3 shrink-0 text-muted-foreground" aria-label="Source no longer available" />}
          </RecipeSlatTitle>
          {row.sourceKind && row.sourceLabel ? (
            <RecipeSlatMeta className="flex items-center gap-1">
              <SourceIcon kind={row.sourceKind} className="size-[11px] shrink-0" />
              <span className="truncate">{row.sourceLabel}</span>
            </RecipeSlatMeta>
          ) : null}
          {row.keywords.length > 0 && <RecipeSlatDetail>{row.keywords.join(" · ")}</RecipeSlatDetail>}
        </RecipeSlatBody>
        {row.totalTimeDisplay && <RecipeSlatAside>{row.totalTimeDisplay}</RecipeSlatAside>}
      </RecipeSlatAction>
    </RecipeSlat>
  );
}

function EmptyBox({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <UtensilsCrossed className="size-8 text-muted-foreground" aria-hidden="true" />
      <div>
        <p className="m-0 text-[0.8125rem] font-bold text-foreground">Your shelf is empty</p>
        <p className="mt-1 mb-0 text-xs text-muted-foreground">Write one out or bring one in from the web to start your household's box.</p>
      </div>
      <Button size="sm" onClick={onAdd}>
        Add a recipe
      </Button>
    </div>
  );
}

function EmptyFilter() {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-14 text-center">
      <UtensilsCrossed className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="m-0 text-[0.8125rem] font-bold text-foreground">Nothing matches that.</p>
      <p className="m-0 text-xs text-muted-foreground">Clear the search, or pick another collection, to see more of your box.</p>
    </div>
  );
}

/** A real, empty collection — a state to fill, not a search that found nothing. */
function EmptyCollection({ name }: { name: string }) {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-14 text-center">
      <FolderLock className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="m-0 text-[0.8125rem] font-bold text-foreground">{name} is empty</p>
      <p className="m-0 text-xs text-pretty text-muted-foreground">Open a recipe and file it here from its collections row.</p>
    </div>
  );
}

/**
 * `?c=` pointing at a collection that is not there any more — someone deleted it
 * while this tab held it, or the link outlived the collection. An inline state, never
 * a 404 (§8): the box is fine, and one control gets you back to it.
 */
function MissingCollection() {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-14 text-center">
      <FolderLock className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="m-0 text-[0.8125rem] font-bold text-foreground">This collection no longer exists.</p>
      <p className="m-0 text-xs text-pretty text-muted-foreground">Someone in your household removed it. Your recipes are all still in the box.</p>
    </div>
  );
}
