import { createContext, useContext } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import type { MealSlot, PlanDate } from "#/lib/plan/week";

/**
 * Everything the planner's cards, cells and popovers can DO, in one context.
 *
 * The route owns all of it — the loader data, the optimistic patch, the toasts,
 * the live region, the dialogs. The tree below it (grid → cell → card →
 * popover, and agenda → slot row → card → popover) is four levels deep and
 * every level would otherwise forward the same eight callbacks it does not use.
 * A context is the smaller thing to maintain, and it keeps `PlanWeekGrid` and
 * `PlanDaysAgenda` free of any prop that exists only to be passed on.
 *
 * The API is deliberately id-in / void-out. Callers never await a mutation and
 * never see its result: the optimistic patch has already repainted, and the
 * route owns the toast, the announcement and the reconciling
 * `router.invalidate()`. A card asking "did that work?" would only be able to
 * draw a second, contradictory answer.
 *
 * There is deliberately no "busy" flag either. Every write here is optimistic
 * and last-write-wins (D10), so a pending request is not a reason to take the
 * planner away from someone mid-thought — the only thing that goes inert is an
 * entry whose id is still a client-side placeholder, and the card knows that
 * from the id itself.
 */
export interface PlanActionsValue {
  /** Open the add dialog aimed at a slot. */
  openAdd(date: PlanDate, slot: MealSlot): void;
  /** Open the add dialog on its note tab, editing an existing note (§6.3). */
  openNoteEditor(entryId: string): void;
  /** Open the move dialog for an entry. */
  openMove(entryId: string): void;
  /** Move without the dialog — what a drop does. Same code path (§8.4). */
  moveEntry(entryId: string, toDate: PlanDate, toSlot: MealSlot): void;
  removeEntry(entryId: string): void;
  setCooked(entryId: string, cooked: boolean): void;
  /** Re-link a recipe that left the box, so the plan card stops saying "not in box". */
  addBackToBox(entryId: string): void;

  /**
   * Drag state. Native HTML5 DnD carries the entry id in `text/plain`, but
   * `dragover` cannot read it (the drag data store is protected until drop), so
   * the id also lives here — that is what lets a cell decide whether to accept
   * the drag at all instead of lighting up for any stray text selection.
   */
  draggingId: string | null;
  setDraggingId(id: string | null): void;
  /** The slot currently under the pointer, as `slotKey(date, slot)`. */
  dragOverSlot: string | null;
  setDragOverSlot(key: string | null): void;
}

const PlanActionsContext = createContext<PlanActionsValue | null>(null);

export const PlanActionsProvider = PlanActionsContext.Provider;

export function usePlanActions(): PlanActionsValue {
  const value = useContext(PlanActionsContext);
  if (!value) throw new Error("usePlanActions must be used inside the plan route's PlanActionsProvider.");
  return value;
}

/** Identifies one of the week's 28 slots for drag-over highlighting. */
export function slotKey(date: PlanDate, slot: MealSlot): string {
  return `${date}|${slot}`;
}

/**
 * The `dragover` / `dragleave` / `drop` trio every slot needs, built once so the
 * grid cell and the agenda row cannot drift apart in behaviour (D14: both views
 * accept drops, and a drop is exactly a move).
 *
 * `dragover` must `preventDefault()` to mark the element a valid drop target —
 * but only for a drag we started, so dragging a file or a text selection over
 * the planner does not paint 28 accent-coloured slots.
 */
export function slotDropHandlers(actions: PlanActionsValue, date: PlanDate, slot: MealSlot) {
  const key = slotKey(date, slot);
  return {
    onDragOver(event: ReactDragEvent<HTMLElement>) {
      if (!actions.draggingId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (actions.dragOverSlot !== key) actions.setDragOverSlot(key);
    },
    onDragLeave(event: ReactDragEvent<HTMLElement>) {
      // Moving onto a child (a card inside the cell) fires dragleave on the
      // cell; without this the highlight strobes as the pointer crosses cards.
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      if (actions.dragOverSlot === key) actions.setDragOverSlot(null);
    },
    onDrop(event: ReactDragEvent<HTMLElement>) {
      const id = event.dataTransfer.getData("text/plain") || actions.draggingId;
      event.preventDefault();
      actions.setDragOverSlot(null);
      actions.setDraggingId(null);
      if (id) actions.moveEntry(id, date, slot);
    },
  };
}
