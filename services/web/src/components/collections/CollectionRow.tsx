import type { ComponentType, DragEventHandler, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { FolderLock, Settings2 } from "lucide-react";
import type { CollectionSummary } from "#/lib/api";
import { selectableRowVariants } from "#/components/ui/selectable-row";
import { cn } from "#/lib/utils";
import type { ScopeSearch } from "./scope";

/**
 * One row of the collections tree — a smart row or a real collection.
 *
 * **The row is a link, not a button.** Scope lives in the URL (§7), so picking a
 * shelf is navigation: it gets middle-click, "open in new tab", a real
 * `aria-current`, and a back button that does what it looks like it does. The
 * gear sits *outside* the link, because a button inside an anchor is invalid
 * HTML that browsers silently reparent.
 *
 * The selected paint is `selectableRowVariants` — the app's one "this row is the
 * current row" treatment (butter fill plus a leading butter bar), the same one
 * the ledger's slats use two hundred pixels to the right. A nav tree and a
 * ledger sitting side by side that disagreed about what "selected" looks like
 * would read as two apps.
 *
 * ## The row is also two drop targets and one drag source (§7)
 *
 * All three are the tree's business, not the row's: `CollectionsTree` owns the
 * order, the mutations and the drag state, and hands the wiring down as `drag`.
 * The row owns only the paint — the ink outline that says "this shelf will take
 * it" and the fade on the row being carried.
 */

/** Native drag wiring for the row element, supplied by `CollectionsTree`. */
export interface CollectionRowDrag {
  /** Armed by the grip, per `useDragHandle` — never true on a row with no handle. */
  draggable?: boolean;
  onDragStart?: DragEventHandler<HTMLLIElement>;
  onDragEnd?: DragEventHandler<HTMLLIElement>;
  onDragOver?: DragEventHandler<HTMLLIElement>;
  onDragLeave?: DragEventHandler<HTMLLIElement>;
  onDrop?: DragEventHandler<HTMLLIElement>;
  /** This row is being carried (fades), or a recipe is hovering over it (outlines). */
  state?: "dragging" | "drop-target" | null;
}

export function CollectionTreeRow({
  icon: Icon,
  label,
  count,
  active,
  search,
  onNavigate,
  trailing,
  leading,
  dropLine,
  drag,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  /** Shown after the name; `null` renders no count at all. */
  count: number | null;
  active: boolean;
  /** The scope this row navigates to. Replaces the layout route's search wholesale. */
  search: ScopeSearch;
  /** Milestone 4's sheet closes itself here; the desktop column passes nothing. */
  onNavigate?: () => void;
  /** Row-level affordances that must not live inside the link (the gear). */
  trailing?: ReactNode;
  /** The drag handle, rendered ahead of the link and outside it. */
  leading?: ReactNode;
  /**
   * The tree's `DropLine`, drawn in the gap at this row's top edge (and, for the
   * last row, its bottom edge). Out of flow, so the row it hangs off does not
   * move when it appears — which is why it is the row's child and not the list's.
   */
  dropLine?: ReactNode;
  /**
   * Desktop drag and drop. Its presence is also what marks the row as a
   * measurable slot for the tree's insertion-point maths
   * (`[data-collection-row]`), so a row that cannot be dragged or dropped on —
   * a smart row, or any row while the browser is offline — is not one.
   */
  drag?: CollectionRowDrag;
}) {
  return (
    <li
      data-collection-row={drag ? "" : undefined}
      draggable={drag?.draggable}
      onDragStart={drag?.onDragStart}
      onDragEnd={drag?.onDragEnd}
      onDragOver={drag?.onDragOver}
      onDragLeave={drag?.onDragLeave}
      onDrop={drag?.onDrop}
      className={cn(
        "group/row relative flex items-center gap-0.5 pr-1",
        selectableRowVariants({ selected: active }),
        // The same ink the drop line is drawn in, as an inset outline: rows sit
        // flush in a scrollport, so an outward ring would land on its neighbours.
        drag?.state === "drop-target" && "bg-accent outline-2 -outline-offset-2 outline-foreground",
        drag?.state === "dragging" && "opacity-40",
      )}
    >
      {dropLine}
      {leading}
      <Link
        to="/household/recipes"
        search={search}
        onClick={onNavigate}
        aria-current={active ? "true" : undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 py-1.5 text-[0.8125rem] font-semibold text-foreground no-underline focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-ring",
          // A row with a grip has already spent its leading gutter on it — but
          // only from `md` up, which is the only place a grip is ever visible
          // (§7). Below that the row keeps the same indent as a smart row,
          // because a `display: none` handle takes up no gutter to pay for.
          leading ? "pl-2.5 md:pl-1" : "pl-2.5",
        )}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count != null && (
          <span className="shrink-0 text-[0.6875rem] font-bold tabular-nums text-muted-foreground">
            {count}
            <span className="sr-only"> {count === 1 ? "recipe" : "recipes"}</span>
          </span>
        )}
      </Link>
      {trailing}
    </li>
  );
}

/**
 * A real collection: name, membership count, and the gear that opens the edit
 * dialog.
 *
 * The gear is hover-revealed but **never hover-only** — it is a real button in
 * the tab order at all times, and `group-focus-within` brings it into view the
 * moment a keyboard reaches the row. Opacity, not `hidden`: a control that
 * leaves the accessibility tree when it is not hovered is a control a screen
 * reader user does not have.
 *
 * The grip in front of the name plays by the same rules, with one addition: it
 * is `max-md:hidden`, because there is no dragging below `md` at all (§7) and a
 * grip you cannot use is furniture. Hiding it in CSS is also what makes the
 * whole gesture inert on a phone — the row is only ever `draggable` while the
 * grip is held, and a hidden grip is never held.
 */
export function CollectionRow({
  collection,
  active,
  onNavigate,
  onEdit,
  leading,
  dropLine,
  drag,
}: {
  collection: CollectionSummary;
  active: boolean;
  onNavigate?: () => void;
  onEdit: (collection: CollectionSummary) => void;
  leading?: ReactNode;
  dropLine?: ReactNode;
  drag?: CollectionRowDrag;
}) {
  return (
    <CollectionTreeRow
      // `folder-lock` is the established glyph for collections (BRAND.md), and
      // the padlock is the honest part: these shelves are household-only.
      icon={FolderLock}
      label={collection.name}
      count={collection.recipeIds.length}
      active={active}
      search={{ c: collection.id }}
      onNavigate={onNavigate}
      leading={leading}
      dropLine={dropLine}
      drag={drag}
      trailing={
        <button
          type="button"
          onClick={() => onEdit(collection)}
          aria-label={`Edit ${collection.name}`}
          className="grid size-6 shrink-0 cursor-(--cursor-interactive) place-content-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring group-hover/row:opacity-100 group-focus-within/row:opacity-100"
        >
          <Settings2 className="size-3.5" aria-hidden="true" />
        </button>
      }
    />
  );
}
