import type * as React from "react";
import { GripVertical } from "lucide-react";
import type { ReorderMove } from "#/lib/reorder";
import { cn } from "#/lib/utils";

/**
 * The two pieces every drag-to-reorder list in the app draws: the **grip** you
 * hold and the **line** that says where the thing will land.
 *
 * They live in `ui/` because three unrelated lists now reorder by dragging — the
 * ingredient/step rows of the recipe form, the collections tree, and a
 * collection-scoped recipe ledger — and a drop line that is 3px in one place and
 * 2px in another, or a grip that is keyboard-reachable in one list and a dead
 * `<span>` in the next, is how a design stops being a design. The *mechanics*
 * stay at the call site (which element is `draggable`, what goes in the
 * `dataTransfer`, what a drop means); this file owns the paint and the keyboard
 * contract.
 *
 * Native HTML5 drag and drop only — no drag library anywhere in this repo. Pair
 * these with `useDragHandle` (`#/lib/hooks/use-drag-source`), which is what keeps
 * a row from being `draggable` until a grip is actually held; a row that is
 * draggable all the time steals click-and-drag selection from every text control
 * inside it.
 */

/**
 * The gap the pointer is nearest, as an **insertion point** — `0..rows.length`,
 * counted between rows rather than on them.
 *
 * Measured from the list element the drag is being read at (`event.currentTarget`),
 * because the gaps between rows belong to no row: a drag read row-by-row goes
 * blind exactly where the drop line is drawn.
 */
export function insertionPointAt(container: HTMLElement, clientY: number, selector: string): number {
  const rows = container.querySelectorAll<HTMLElement>(selector);
  for (const [index, row] of rows.entries()) {
    const box = row.getBoundingClientRect();
    if (clientY < box.top + box.height / 2) return index;
  }
  return rows.length;
}

/**
 * The line the dragged row will land on: 3px of `foreground` sitting in the gap
 * between two rows, with a cap at each end so it reads as an insertion point and
 * not as a border someone drew on a row.
 *
 * `pointer-events-none` is load-bearing — a drop line under the pointer would
 * otherwise take the drop events the list is measuring, and the line would fight
 * the cursor it is following. It is `aria-hidden` because the same information
 * reaches a screen reader through the handle's own keyboard path, which does not
 * involve a pointer position at all.
 */
export function DropLine({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("pointer-events-none absolute inset-x-0 z-10 flex items-center", className)}>
      <span className="size-[7px] shrink-0 rounded-full bg-foreground" />
      <span className="h-[3px] flex-1 bg-foreground" />
      <span className="size-[7px] shrink-0 rounded-full bg-foreground" />
    </div>
  );
}

const gripClass = "-m-1 flex shrink-0 cursor-grab p-1 text-muted-foreground";

/**
 * The grip. Two shapes, and which one you get is decided by one question: **is
 * dragging this thing the only way to do the job?**
 *
 * - `onMove` given → a real `<button>` in the tab order, with the arrow keys
 *   doing what the drag does (`↑`/`↓` one place, `Home`/`End` to an end).
 *   Reordering has no other affordance anywhere in the app, so without this the
 *   feature simply does not exist for a keyboard, and dragging is also the one
 *   gesture a switch or head-pointer user cannot make (WCAG 2.5.7).
 * - `onMove` omitted → an `aria-hidden` `<span>`: a pointer accelerator for
 *   something that already has a full non-drag path (filing a recipe into a
 *   collection, which the collections picker and the mobile sheets are for).
 *   A focusable control that does nothing when you press it is worse than no
 *   control.
 *
 * `label` is the accessible name and should name the row — "Reorder Weeknights",
 * not "Reorder" — because the handles of ten rows are otherwise ten identically
 * named buttons in the tab order.
 */
export function DragHandle({
  label,
  title,
  onMove,
  onPointerDown,
  className,
}: {
  label: string;
  /**
   * A pointer-only hint ("Drag onto a collection to file it"). Worth setting on a
   * decorative grip, whose job is not guessable from a picture of a grip; leave
   * it off a keyboard handle, where it would only duplicate `label`.
   */
  title?: string;
  /** Present ⇒ the handle is a keyboard control, absent ⇒ a decorative grip. */
  onMove?: (move: ReorderMove) => void;
  /** From `useDragHandle().handleProps` — arms the row while the grip is held. */
  onPointerDown?: React.PointerEventHandler<HTMLElement>;
  className?: string;
}) {
  const grip = <GripVertical className="size-4" aria-hidden="true" />;

  if (!onMove) {
    return (
      <span aria-hidden="true" title={title} onPointerDown={onPointerDown} className={cn(gripClass, className)}>
        {grip}
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-label={label}
      aria-keyshortcuts="ArrowUp ArrowDown Home End"
      title={title}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        const move: ReorderMove | null = event.key === "ArrowUp" ? "up" : event.key === "ArrowDown" ? "down" : event.key === "Home" ? "top" : event.key === "End" ? "bottom" : null;
        if (!move) return;
        // Arrow keys scroll the list this handle sits in, and Home/End jump it to
        // an end — both would fight the move they just made.
        event.preventDefault();
        onMove(move);
      }}
      className={cn(gripClass, "rounded-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring", className)}
    >
      {grip}
    </button>
  );
}
