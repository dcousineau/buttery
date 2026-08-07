import { useEffect, useState } from "react";
import { addMealPlanRecipes, getPlanToday } from "#/server/meal-plan";
import { MEAL_SLOTS, type MealSlot, type PlanDate, shiftDays } from "#/lib/plan/week";
import { SLOT_LABELS, formatPlanDate, shortDow } from "#/lib/plan/labels";
import { Button } from "#/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "#/components/ui/dialog";
import { Select } from "#/components/ui/select";
import { Spinner } from "#/components/ui/spinner";

/**
 * "Add to meal planner", from a recipe (§7.5).
 *
 * The planner's own add flow starts from a slot and asks which recipes; this one
 * starts from the recipe and asks which slot, so it is a different dialog rather
 * than a reuse of `AddEntryDialog`. It stays on the recipe: someone reading a
 * recipe and deciding to cook it on Thursday wants the recipe back afterwards,
 * not the week.
 *
 * Two native `<select>`s, matching `MoveEntryDialog` — same shape of question,
 * same answer.
 */

/** The recipe being planned. Null ⇒ closed. */
export interface AddToPlanRequest {
  recipeId: string;
  title: string;
}

interface AddToPlanDialogProps {
  request: AddToPlanRequest | null;
  onClose(): void;
  /** Fired after the entry is on the plan — the caller owns the confirmation. */
  onAdded(date: PlanDate, slot: MealSlot): void;
}

/**
 * How far ahead a recipe can be planned from here: today plus a fortnight.
 *
 * Long enough to cover "this week and next", which is as far as most planning
 * ever reaches, and short enough that the list stays one glance rather than a
 * scroll. Anything further out is the planner's job, where the week is visible.
 */
const DAYS_OFFERED = 14;

export function AddToPlanDialog({ request, ...props }: AddToPlanDialogProps) {
  // Closing unmounts the form, so each open starts at today/dinner rather than
  // wherever the last add left the selects.
  if (!request) return null;
  return <AddToPlanForm request={request} {...props} />;
}

function AddToPlanForm({ request, onClose, onAdded }: Omit<AddToPlanDialogProps, "request"> & { request: AddToPlanRequest }) {
  /**
   * Today has to come from the server: plan dates are anchored to the household
   * timezone (§2.3), and the browser's clock is the wrong clock for a household
   * spread across two of them. Until it lands there is no legal date to default
   * to, so the form waits rather than guessing one it would have to correct.
   */
  const [today, setToday] = useState<PlanDate | null>(null);
  const [date, setDate] = useState<PlanDate | null>(null);
  const [slot, setSlot] = useState<MealSlot>("dinner");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getPlanToday()
      .then((result) => {
        if (!live) return;
        setToday(result.today);
        setDate(result.today);
      })
      .catch(() => {
        if (live) setError("Couldn’t work out today’s date. Close this and try again.");
      });
    return () => {
      live = false;
    };
  }, []);

  const dates = today ? Array.from({ length: DAYS_OFFERED }, (_, offset) => shiftDays(today, offset)) : [];

  async function submit() {
    if (!date) return;
    setSaving(true);
    setError(null);
    try {
      await addMealPlanRecipes({ data: { date, slot, recipeIds: [request.recipeId] } });
      onAdded(date, slot);
      onClose();
    } catch {
      // Left open on failure: the dialog is the only surface this flow has, and
      // closing it would take the retry away along with the message.
      setError("Couldn’t add it to the plan. Try again.");
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle>Add to the plan</DialogTitle>
        <DialogDescription>Pick a day and a meal for {request.title}.</DialogDescription>

        {today == null ? (
          <div className="flex items-center gap-2 py-2 text-xs font-semibold text-muted-foreground">
            <Spinner className="size-4" />
            Loading the week…
          </div>
        ) : (
          <div className="flex gap-2.5">
            <label className="flex flex-1 flex-col gap-1 text-xs font-semibold">
              Day
              <Select size="sm" value={date ?? today} onChange={(event) => setDate(event.target.value as PlanDate)}>
                {dates.map((option, offset) => (
                  <option key={option} value={option}>
                    {dayLabel(option, offset)}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-1 flex-col gap-1 text-xs font-semibold">
              Meal
              <Select size="sm" value={slot} onChange={(event) => setSlot(event.target.value as MealSlot)}>
                {MEAL_SLOTS.map((option) => (
                  <option key={option} value={option}>
                    {SLOT_LABELS[option]}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        )}

        {error && (
          <p role="alert" className="m-0 text-xs font-semibold text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
          <Button size="sm" disabled={!date || saving} onClick={submit}>
            {saving ? "Adding…" : "Add to plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Today · Fri, Aug 7" for the two dates that have names, "Sat · Aug 8" after. */
function dayLabel(date: PlanDate, offset: number): string {
  const named = offset === 0 ? "Today" : offset === 1 ? "Tomorrow" : null;
  return named ? `${named} · ${shortDow(date)}, ${formatPlanDate(date)}` : `${shortDow(date)} · ${formatPlanDate(date)}`;
}
