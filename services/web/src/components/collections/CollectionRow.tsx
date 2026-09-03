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
 * collection is navigation: it gets middle-click, "open in new tab", a real
 * `aria-current`, and a back button that does what it looks like it does. The
 * gear sits *outside* the link, because a button inside an anchor is invalid
 * HTML that browsers silently reparent.
 *
 * ## Every row has the same content box
 *
 * A smart row has no grip and no gear; a collection row has both. If either one
 * sat in the flow, the row that had them would have a narrower content box than
 * the row that did not — the label pushed right by the grip, the count pushed
 * left by the gear — and the two kinds of row would disagree about where a
 * label and a count belong. That is exactly what they used to do.
 *
 * So **neither affordance is in the flow**. Both are absolutely positioned
 * against the `<li>`, which is already the positioning context (the drop line
 * hangs off it), and the link pays for them with padding *every* row has:
 *
 * - **Left** — the grip is `max-md:hidden`, so below `md` it costs nothing and
 *   the rows keep the plain `pl-2.5`. From `md` up every row shares one 2rem
 *   gutter, wide enough to clear the grip's 24px hit box at its 6px offset.
 *   Shared, so nothing is indented relative to anything else.
 * - **Right** — the gear is there at every width, so the padding is too: `pr-8`
 *   clears the 24px gear, and `touch:pr-13` clears the 44px one. The gear must
 *   never sit on top of the count, on any pointer: it is a button painted above
 *   the link, so any overlap would be a tap the row link never gets.
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
 * The row owns only the paint — the ink outline that says "this collection will
 * take it" and the fade on the row being carried.
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
  /**
   * Row-level affordances that must not live inside the link (the gear). Pinned
   * to the row's right edge, out of flow — see the note above.
   */
  trailing?: ReactNode;
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
        // `touch:` is where the touch sizing lives — the app-wide variant
        // (styles.css), which fires on a coarse pointer *or* below `md`. It used
        // to be `pointer-coarse:` alone, on the argument that a finger needs
        // 44px and a mouse does not; but this tree's only `<md` surface is a
        // sheet, and a phone-width window that kept 30px rows disagreed with
        // every other nav row in the app. Milestone 4 had to apply these from
        // outside (`TOUCH_TREE` in `CollectionsSheet`) because it did not own
        // this file; they belong here, on the elements they describe.
        "group/row relative flex items-center touch:min-h-(--nav-row-h-touch)",
        selectableRowVariants({ selected: active }),
        // The same ink the drop line is drawn in, as an inset outline: rows sit
        // flush in a scrollport, so an outward ring would land on its neighbours.
        drag?.state === "drop-target" && "bg-accent outline-2 -outline-offset-2 outline-foreground",
        drag?.state === "dragging" && "opacity-40",
      )}
    >
      {dropLine}
      <Link
        to="/household/recipes"
        search={search}
        onClick={onNavigate}
        aria-current={active ? "true" : undefined}
        // Uniform on every row: one indent for smart rows and collections
        // alike, and a right pad that clears the pinned gear — `pr-8` for the
        // 24px one, `touch:pr-13` for the 44px one — so the count sits at the
        // same x whether or not the row has a gear.
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-8 pl-2.5 text-[0.8125rem] font-semibold text-foreground no-underline focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-ring touch:min-h-(--nav-row-h-touch) touch:gap-3 touch:pr-13 touch:pl-3.5 touch:text-base"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground touch:size-5" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count != null && (
          <span className="shrink-0 text-[0.6875rem] font-bold tabular-nums text-muted-foreground touch:text-xs">
            {count}
            <span className="sr-only"> {count === 1 ? "recipe" : "recipes"}</span>
          </span>
        )}
      </Link>
      {/* Pinned to the right edge, 4px in, and vertically centred whatever the
        row's height — so the count sits at the same x on a row that has a gear
        and a row that does not. */}
      {trailing && <span className="absolute inset-y-0 right-1 flex items-center">{trailing}</span>}
    </li>
  );
}

/**
 * A real collection: name, membership count, and the gear that opens the edit
 * dialog.
 *
 * The gear is hover-revealed but **never hover-only** — it is a real button in
 * the tab order at all times, `group-focus-within` brings it into view the
 * moment a keyboard reaches the row, and on a coarse pointer it is visible and
 * 44px from the start, because a touch device has no hover to reveal it with.
 * Opacity, not `hidden`: a control that leaves the accessibility tree when it is
 * not hovered is a control a screen reader user does not have. It is also out
 * of flow (see `CollectionTreeRow`), which is why appearing and disappearing
 * never moves the count it sits beside.
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
  dropLine,
  drag,
}: {
  collection: CollectionSummary;
  active: boolean;
  onNavigate?: () => void;
  onEdit: (collection: CollectionSummary) => void;
  dropLine?: ReactNode;
  drag?: CollectionRowDrag;
}) {
  return (
    <CollectionTreeRow
      // `folder-lock` is the established glyph for collections (BRAND.md), and
      // the padlock is the honest part: these collections are household-only.
      icon={FolderLock}
      label={collection.name}
      count={collection.recipeIds.length}
      active={active}
      search={{ c: collection.id }}
      onNavigate={onNavigate}
      dropLine={dropLine}
      drag={drag}
      trailing={
        <button
          type="button"
          onClick={() => onEdit(collection)}
          aria-label={`Edit ${collection.name}`}
          // Hover-revealed for a mouse; on the `touch` layer there IS no hover
          // to reveal it with (BRAND.md is explicit about it), so the gear that
          // opens the edit sheet is simply there, at the 44px floor. Without
          // this, touch has no way in.
          className="grid size-6 shrink-0 cursor-(--cursor-interactive) place-content-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring group-hover/row:opacity-100 group-focus-within/row:opacity-100 touch:size-(--control-h-touch) touch:rounded-lg touch:opacity-100"
        >
          <Settings2 className="size-3.5 touch:size-5" aria-hidden="true" />
        </button>
      }
    />
  );
}
