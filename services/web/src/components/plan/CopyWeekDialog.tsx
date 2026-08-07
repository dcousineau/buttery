import { useState } from "react";
import { type PlanDate, shiftDays } from "#/lib/plan/week";
import { weekRangeLabel } from "#/lib/plan/labels";
import { Button } from "#/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "#/components/ui/dialog";
import { RadioCard, RadioGroup } from "#/components/ui/radio-group";

/**
 * "Copy this week forward?" (§6.7) — the panel's primary action.
 *
 * The destination is always the NEXT week, never a picker: the design offers one
 * question ("what happens to what is already there?"), and a week-picker would
 * turn a two-second action into a form. Copying somewhere else is still possible
 * — navigate to that week and copy backwards is not a thing anyone asked for, so
 * it isn't built.
 *
 * The two modes are stated as consequences rather than verbs ("Keeps next week's
 * entries and appends these at the end of each slot"), because `append` and
 * `replace` are only distinguishable by what they do to entries the user cannot
 * see from this week.
 */

interface CopyWeekDialogProps {
  /** The week on screen. Null ⇒ closed (and the mode resets on the next open). */
  weekStart: PlanDate | null;
  onClose(): void;
  onCopy(fromWeek: PlanDate, toWeek: PlanDate, mode: "append" | "replace"): void;
}

export function CopyWeekDialog({ weekStart, ...props }: CopyWeekDialogProps) {
  // Same construction as MoveEntryDialog: closing unmounts the form, so each
  // open starts from the default mode rather than from the last choice.
  if (!weekStart) return null;
  return <CopyWeekForm weekStart={weekStart} {...props} />;
}

function CopyWeekForm({ weekStart, onClose, onCopy }: Omit<CopyWeekDialogProps, "weekStart"> & { weekStart: PlanDate }) {
  const [mode, setMode] = useState<"append" | "replace">("append");
  const toWeek = shiftDays(weekStart, 7);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle>Copy this week forward?</DialogTitle>
        <DialogDescription>
          Everything from {weekRangeLabel(weekStart, shiftDays(weekStart, 6))} lands on the same weekdays of {weekRangeLabel(toWeek, shiftDays(weekStart, 13))}.
        </DialogDescription>

        <RadioGroup aria-label="What to do with next week">
          <RadioCard
            size="sm"
            name="copy-week-mode"
            value="append"
            checked={mode === "append"}
            onChange={() => setMode("append")}
            title="Add to what’s there"
            description="Keeps next week's entries and appends these at the end of each slot."
          />
          <RadioCard
            size="sm"
            name="copy-week-mode"
            value="replace"
            checked={mode === "replace"}
            onChange={() => setMode("replace")}
            title="Replace next week"
            description="Clears next week first, then copies. Cooked marks are not carried over."
          />
        </RadioGroup>

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
          <Button
            size="sm"
            onClick={() => {
              onCopy(weekStart, toWeek, mode);
              onClose();
            }}
          >
            Copy the week
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
