import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { BookOpenText, Clock, Lock, Star } from "lucide-react";
import {
  addRecipesToCollectionMutation,
  type CollectionSummary,
  createCollection,
  householdCollectionsQuery,
  householdRecipesQuery,
  keys,
  reorderCollectionsMutation,
} from "#/lib/api";
import { OFFLINE_WRITE_HINT, useIsOnline } from "#/lib/offline/use-online";
import { useDragHandle } from "#/lib/hooks/use-drag-source";
import { DragHandle, DropLine, insertionPointAt } from "#/components/ui/drag-reorder";
import { moveByKey, moveToInsertionPoint, type ReorderMove } from "#/lib/reorder";
import { useRecipesView } from "#/components/recipes/context";
import { cn } from "#/lib/utils";
import { CollectionRow, CollectionTreeRow } from "./CollectionRow";
import { COLLECTION_DRAG_TYPE, dragCarries, RECIPE_DRAG_TYPE } from "./drag";
import { EditCollectionDialog } from "./EditCollectionDialog";
import { useStaleToast } from "./use-stale-toast";
import { QuickAddRow } from "./QuickAddRow";
import { DEFAULT_SCOPE, resolveScope, SMART_SCOPE_LABELS, SMART_SCOPES, type SmartScope, smartScopeCount } from "./scope";

/**
 * The collections tree: four smart rows, the household's collections, and the
 * inline quick-add — collections plan §7.
 *
 * **This component is the whole feature's navigation, and it takes almost no
 * props on purpose.** It reads the two cached queries itself and writes its
 * selection to the URL, so mounting it is the entire integration: the desktop
 * column wraps it in an `<aside>`, and milestone 4's `CollectionsSheet` wraps it
 * in a `Sheet` and passes `onNavigate` to close the sheet behind a tap. Neither
 * wrapper has to know what a scope is, and milestone 4 must not have to edit
 * this file.
 *
 * Both reads are `useSuspenseQuery` against entries the layout route's loader
 * has already primed — so this suspends only in the pathological case, and gets
 * refetch-on-reconnect and prefix invalidation for free (offline plan §4.1).
 *
 * The **smart rows replace the ledger's sort dropdown and its old "My recipes"
 * lock-chip** (§2.2). That chip was an unpublished-only filter wearing the wrong
 * name; "Unpublished" here is the same filter, honestly labelled.
 *
 * ## Two drags land here, and they are not the same drag (§7)
 *
 * - **A collection row, dragged by its grip** — reorders the household's list.
 *   Read at the `<ul>`, because the drop line is drawn in the gaps between rows
 *   and the gaps belong to no row. That order is **local-only and never
 *   published** (§2.10): `reorderCollections` is the one write in the feature
 *   with no re-put behind it.
 * - **A recipe, dragged from the ledger** — files onto whichever row it is
 *   dropped on. Read at the row, because here the row *is* the target.
 *
 * They cannot cross-drop: each carries its own MIME type (`./drag.ts`) and each
 * target only calls `preventDefault()` for its own, so the browser paints
 * "no drop" for the other one instead of quietly accepting it.
 *
 * Every bit of it is desktop-only (§7). The grips are `max-md:hidden`, and since
 * a row is only `draggable` while its grip is held (`useDragHandle`), a hidden
 * grip means a phone cannot start either drag at all — no media query in JS, no
 * touch shim, nothing to keep in sync.
 */

const SMART_ICONS: Record<SmartScope, typeof BookOpenText> = {
  mine: BookOpenText,
  recent: Clock,
  favorites: Star,
  unpublished: Lock,
};

export function CollectionsTree({ householdId, onNavigate, className }: { householdId: string; onNavigate?: () => void; className?: string }) {
  const { data: recipes } = useSuspenseQuery(householdRecipesQuery(householdId));
  const { data: collections } = useSuspenseQuery(householdCollectionsQuery(householdId));
  const search = useSearch({ from: "/household/recipes" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const online = useIsOnline();
  const { pushToast } = useRecipesView();
  const reorder = useMutation(reorderCollectionsMutation(queryClient, householdId));
  const file = useMutation(addRecipesToCollectionMutation(queryClient, householdId));
  const { notifyStale } = useStaleToast(householdId);

  /**
   * Which collection the edit dialog is on — an **id**, resolved back to the
   * live summary below rather than held as a snapshot. A snapshot would freeze
   * the dialog's member list at the moment it opened, so unfiling a recipe from
   * inside the dialog moved the tree's count and left the list it was removed
   * from still showing it.
   */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // The row being carried, by index, and the gap it would land in — an
  // *insertion point* (0…collections.length), counted between rows rather than
  // on them, because a target painted on a row cannot say whether the row lands
  // above it or below it.
  const [dragging, setDragging] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  /** The shelf a dragged recipe is currently hovering over. */
  const [fileTarget, setFileTarget] = useState<string | null>(null);
  /** What the last reorder did, for people who cannot see the rows move. */
  const [moved, setMoved] = useState("");
  // One hook for the whole list: only one grip can be under the pointer, so only
  // the pressed row can arm itself.
  const { armed, handleProps, disarm } = useDragHandle();

  const scope = resolveScope(search, collections);
  // Gone from the list (deleted by another member) closes the dialog by itself.
  const editing = collections.find((collection) => collection.id === editingId) ?? null;
  const ids = collections.map((collection) => collection.id);
  // Writes are online-only (§6), and dragging is a write. Offline, the grips are
  // simply not there — a drag that cannot be saved should not start.
  const reorderable = online && collections.length > 1;

  /**
   * Create is **not** optimistic (§6): the server mints the ULID and the
   * position, so there is nothing truthful to render until it answers. It does
   * return the finished summary, though, which is why quick-add can select the
   * new collection on the same tick rather than waiting for the invalidation to
   * land.
   */
  async function onCreate(name: string) {
    setCreating(true);
    try {
      const created = await createCollection({ name });
      await queryClient.invalidateQueries({ queryKey: keys.household.collections(householdId) });
      await navigate({ to: "/household/recipes", search: { c: created.id } });
      onNavigate?.();
    } catch {
      pushToast("That collection didn't save. Try again.");
    } finally {
      setCreating(false);
    }
  }

  /**
   * The one place the new order is written, from both the drag and the keyboard.
   *
   * The tree renders every collection the household has, so the order it sends
   * is the whole order by construction — unlike the scoped ledger, which renders
   * a subset and has to fold its result back into the full one.
   */
  function commitOrder(nextIds: string[], movedIndex: number) {
    if (nextIds === ids) return;
    reorder.mutate({ orderedIds: nextIds });
    const name = collections[movedIndex]?.name ?? "";
    setMoved(`${name} moved to ${nextIds.indexOf(ids[movedIndex]) + 1} of ${nextIds.length}.`);
  }

  function onMove(index: number, move: ReorderMove) {
    commitOrder(moveByKey(ids, index, move), index);
  }

  function endDrag() {
    setDragging(null);
    setDropAt(null);
    setFileTarget(null);
    disarm();
  }

  /** A recipe card dropped on a shelf (§7's third surface). */
  async function fileRecipe(collection: CollectionSummary, recipeId: string) {
    if (collection.recipeIds.includes(recipeId)) {
      // Filing something twice is a silent no-op server-side (§8) — but silence
      // here would read as a drag that missed.
      pushToast(`Already on ${collection.name}`);
      return;
    }
    try {
      const result = await file.mutateAsync({ collectionId: collection.id, recipeIds: [recipeId] });
      if (result.ok) {
        pushToast(`Filed on ${collection.name}`);
        // Filed here, but the publisher's copy of the shelf is behind (§5). The
        // "Publish recipe & add" combo is deliberately not offered on a drop:
        // making a recipe public is a decision, and a drag is not the gesture to
        // take it with — the picker and the sheets ask properly.
        if (result.stale) notifyStale(collection);
      } else if (result.reason === "recipes_unpublished") {
        pushToast(`${collection.name} is published, so it can only hold published recipes.`);
      } else {
        pushToast("That didn't file. Try again.");
      }
    } catch {
      pushToast("That didn't file. Try again.");
    }
  }

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      {/* Matches the ledger's filter-bar box exactly (same padding, same 30px
        control row) so the two column heads line up across the divider. */}
      <div className="flex flex-none items-center border-b-2 border-border bg-card px-2.5 py-2">
        <h2 className="m-0 flex h-[30px] items-center text-[0.6875rem] font-bold tracking-[0.06em] text-muted-foreground uppercase">Collections</h2>
      </div>

      <nav aria-label="Recipe collections" className="min-h-0 flex-1 overflow-auto py-1">
        <ul className="m-0 list-none p-0">
          {SMART_SCOPES.map((smart) => (
            <CollectionTreeRow
              key={smart}
              icon={SMART_ICONS[smart]}
              label={SMART_SCOPE_LABELS[smart]}
              count={smartScopeCount(recipes, smart)}
              active={scope.kind === "smart" && scope.scope === smart}
              // The landing scope is spelled by leaving the param out, so the
              // default view has one URL rather than two.
              search={{ scope: smart === DEFAULT_SCOPE ? undefined : smart }}
              onNavigate={onNavigate}
            />
          ))}
        </ul>

        <h3 className="m-0 px-2.5 pt-3 pb-1 text-[0.6875rem] font-bold tracking-[0.06em] text-muted-foreground uppercase">Your shelves</h3>

        {collections.length === 0 ? (
          <p className="m-0 px-2.5 pb-1 text-xs text-pretty text-muted-foreground">Nothing here yet. A shelf is just a name and the recipes you file on it.</p>
        ) : (
          <ul
            className="m-0 list-none p-0"
            // The reorder is read at the list, not at each row: the drop line is
            // drawn between rows, and a drag read row-by-row goes blind exactly
            // there. A recipe drag never gets this far — it has the wrong type,
            // and `dragging` is null anyway.
            onDragOver={(event) => {
              if (dragging === null || !dragCarries(event.dataTransfer, COLLECTION_DRAG_TYPE)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDropAt(insertionPointAt(event.currentTarget, event.clientY, "[data-collection-row]"));
            }}
            onDragLeave={(event) => {
              // Only a departure from the list itself counts — crossing between
              // two rows fires dragleave too, and hiding the line there would
              // strobe it.
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(null);
            }}
            onDrop={(event) => {
              if (dragging === null || !dragCarries(event.dataTransfer, COLLECTION_DRAG_TYPE)) return;
              event.preventDefault();
              if (dropAt !== null) commitOrder(moveToInsertionPoint(ids, dragging, dropAt), dragging);
              endDrag();
            }}
          >
            {collections.map((collection, index) => (
              <CollectionRow
                key={collection.id}
                collection={collection}
                active={scope.kind === "collection" && scope.collection.id === collection.id}
                onNavigate={onNavigate}
                onEdit={(target) => setEditingId(target.id)}
                leading={
                  reorderable ? (
                    <DragHandle
                      // Ten rows whose handles are all called "Reorder" are ten
                      // buttons a screen reader cannot tell apart.
                      label={`Reorder ${collection.name}`}
                      onMove={(move) => onMove(index, move)}
                      onPointerDown={handleProps.onPointerDown}
                      className="ml-1.5 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 max-md:hidden"
                    />
                  ) : undefined
                }
                dropLine={
                  dropAt === index ? (
                    <DropLine className="-top-[1.5px]" />
                  ) : dropAt === collections.length && index === collections.length - 1 ? (
                    // The one landing place no gap above a row can express.
                    <DropLine className="-bottom-[1.5px]" />
                  ) : undefined
                }
                drag={
                  online
                    ? {
                        draggable: armed,
                        onDragStart: (event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData(COLLECTION_DRAG_TYPE, collection.id);
                          setDragging(index);
                          setDropAt(index);
                        },
                        onDragEnd: endDrag,
                        // Filing is the row's own drag, and it is a different one:
                        // a recipe, not a collection, and it lands *on* the row.
                        onDragOver: (event) => {
                          if (!dragCarries(event.dataTransfer, RECIPE_DRAG_TYPE)) return;
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "copy";
                          if (fileTarget !== collection.id) setFileTarget(collection.id);
                        },
                        onDragLeave: (event) => {
                          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                          setFileTarget((current) => (current === collection.id ? null : current));
                        },
                        onDrop: (event) => {
                          if (!dragCarries(event.dataTransfer, RECIPE_DRAG_TYPE)) return;
                          event.preventDefault();
                          event.stopPropagation();
                          const recipeId = event.dataTransfer.getData(RECIPE_DRAG_TYPE);
                          setFileTarget(null);
                          if (recipeId) void fileRecipe(collection, recipeId);
                        },
                        state: dragging === index ? "dragging" : fileTarget === collection.id ? "drop-target" : null,
                      }
                    : undefined
                }
              />
            ))}
          </ul>
        )}

        {/* Writes are online-only (§6), so the row disables rather than queuing
          a create whose id the client could not predict anyway. */}
        <QuickAddRow onCreate={onCreate} pending={creating} disabled={!online || creating} disabledHint={online ? undefined : OFFLINE_WRITE_HINT} />
      </nav>

      {/* A reorder is invisible to anyone not watching the rows move, and the
        drop line is deliberately `aria-hidden`, so the move says itself here. */}
      <p className="sr-only" role="status" aria-live="polite">
        {moved}
      </p>

      <EditCollectionDialog
        householdId={householdId}
        collection={editing}
        recipes={recipes}
        onOpenChange={(open) => {
          if (!open) setEditingId(null);
        }}
      />
    </div>
  );
}
