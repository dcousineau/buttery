import { useState } from "react";
import { MEAL_SLOTS, type MealSlot, type PlanDate } from "#/lib/plan/week";
import { SLOT_LABELS, formatPlanDate, shortDow } from "#/lib/plan/labels";
import { Button } from "#/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "#/components/ui/dialog";
import { Select } from "#/components/ui/select";

/**
 * The keyboard route to a move (§6.4).
 *
 * Dragging is the fast way and this is the reachable one — the popover's
 * "Move to…" for anyone not using a pointer, on a touch screen where HTML5 drag
 * does not fire, or moving to a slot that is scrolled off the grid. Both end in
 * the same `moveEntry` call, so there is exactly one move to reason about.
 *
 * Two native `<select>`s rather than a day/slot picker grid: 28 destinations is
 * a lot of tab stops, and the pair reads as one sentence ("Wed · Aug 5",
 * "Dinner") in the same order the description states the current position.
 */

/** The entry being moved, and where it sits now. Null ⇒ closed. */
export interface MoveEntryRequest {
  entryId: string;
  fromDate: PlanDate;
  fromSlot: MealSlot;
}

interface MoveEntryDialogProps {
  request: MoveEntryRequest | null;
  /** The seven dates of the week on screen — the only destinations offered. */
  dates: PlanDate[];
  onClose(): void;
  onMove(entryId: string, toDate: PlanDate, toSlot: MealSlot): void;
}

export function MoveEntryDialog({ request, ...props }: MoveEntryDialogProps) {
  // Closing unmounts the form, so each open starts from where its entry
  // actually is rather than from wherever the last move left the selects.
  if (!request) return null;
  return <MoveEntryForm request={request} {...props} />;
}

function MoveEntryForm({ request, dates, onClose, onMove }: Omit<MoveEntryDialogProps, "request"> & { request: MoveEntryRequest }) {
  const [date, setDate] = useState<PlanDate>(request.fromDate);
  const [slot, setSlot] = useState<MealSlot>(request.fromSlot);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle>Move this entry</DialogTitle>
        <DialogDescription>
          Currently {SLOT_LABELS[request.fromSlot].toLowerCase()} on {formatPlanDate(request.fromDate)}. Pick where it should go.
        </DialogDescription>

        <div className="flex gap-2.5">
          <label className="flex flex-1 flex-col gap-1 text-xs font-semibold">
            Day
            <Select size="sm" value={date} onChange={(event) => setDate(event.target.value)}>
              {dates.map((option) => (
                <option key={option} value={option}>
                  {shortDow(option)} · {formatPlanDate(option)}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs font-semibold">
            Slot
            <Select size="sm" value={slot} onChange={(event) => setSlot(event.target.value as MealSlot)}>
              {MEAL_SLOTS.map((option) => (
                <option key={option} value={option}>
                  {SLOT_LABELS[option]}
                </option>
              ))}
            </Select>
          </label>
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
          <Button
            size="sm"
            onClick={() => {
              onMove(request.entryId, date, slot);
              onClose();
            }}
          >
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
