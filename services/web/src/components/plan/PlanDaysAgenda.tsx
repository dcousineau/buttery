import { Plus } from "lucide-react";
import type { PlanWeek } from "#/server/meal-plan";
import { MEAL_SLOTS } from "#/lib/plan/week";
import { SLOT_LABELS, addToSlotLabel, formatPlanDate, longDow } from "#/lib/plan/labels";
import { Badge } from "#/components/ui/badge";
import { PlanEntryCard } from "./PlanEntryCard";
import { slotDropHandlers, slotKey, usePlanActions } from "./PlanActions";
import { cn } from "#/lib/utils";

/**
 * The days view: one card per day, seven cards stacked. This is also the layout
 * the week grid falls back to below `md` (D16), so — unlike the grid — it has to
 * work on a phone.
 *
 * The comp draws the tablet form: a 120px day column beside the slot rows, each
 * row a 76px label beside its entries. (The comp says 104px, but its day names
 * are placeholders — "Wednesday" in Alfa Slab One at 18px measures ~112px, and
 * the app's global `overflow-wrap: anywhere` breaks it as "Wednesda/y" rather
 * than overflowing. 120px is the smallest round track that fits the longest
 * weekday.) Below `sm` that folds to a single column
 * (day name and date on one line above the card, slot label above its entries)
 * so nothing scrolls sideways on a 360px screen.
 *
 * Slot rows are drop targets too, so a drag started in this view has somewhere
 * to land without switching layouts (D14).
 */
export function PlanDaysAgenda({ week }: { week: PlanWeek }) {
  const actions = usePlanActions();

  return (
    <>
      {week.days.map((day) => (
        <section
          key={day.date}
          aria-label={`${longDow(day.date)}, ${formatPlanDate(day.date)}`}
          className={cn(
            "grid shrink-0 grid-cols-1 gap-2 rounded-xl border-2 border-border px-3 py-2.5 sm:min-w-[30rem] sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-3",
            day.isPast ? "bg-muted/45" : "bg-card",
            day.isToday ? "shadow-pop-md" : "shadow-pop-sm",
          )}
        >
          <header className="flex flex-row flex-wrap items-baseline gap-x-2 gap-y-0.5 sm:flex-col sm:items-start">
            <h2 className="display-title m-0 text-lg leading-[1.1]">{longDow(day.date)}</h2>
            <span className="text-xs font-semibold text-muted-foreground">{formatPlanDate(day.date)}</span>
            {day.isToday && (
              <Badge variant="secondary" size="xs">
                today
              </Badge>
            )}
          </header>

          <div className="flex min-w-0 flex-col gap-[5px]">
            {MEAL_SLOTS.map((slot) => (
              <div
                key={slot}
                data-plan-slot=""
                {...slotDropHandlers(actions, day.date, slot)}
                className={cn(
                  "grid grid-cols-1 items-start gap-0.5 rounded-sm px-1 py-[3px] sm:grid-cols-[76px_minmax(0,1fr)] sm:gap-2.5",
                  actions.dragOverSlot === slotKey(day.date, slot) && "bg-accent",
                )}
              >
                <span className="pt-[5px] text-[0.625rem] font-bold tracking-wide text-muted-foreground uppercase">{SLOT_LABELS[slot]}</span>
                <div className="flex min-w-0 flex-col items-start gap-1.5">
                  {day.slots[slot].map((entry) => (
                    <div key={entry.id} className="w-full sm:max-w-[26rem]">
                      <PlanEntryCard entry={entry} date={day.date} slot={slot} variant="days" isPast={day.isPast} />
                    </div>
                  ))}
                  <button
                    type="button"
                    data-plan-add=""
                    onClick={() => actions.openAdd(day.date, slot)}
                    title={addToSlotLabel(slot, day.date)}
                    aria-label={addToSlotLabel(slot, day.date)}
                    className="inline-flex items-center gap-1 rounded-4xl border-2 border-dashed border-border/45 px-2 py-0.5 text-[0.6875rem] font-bold text-muted-foreground hover:border-border hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
                  >
                    <Plus className="size-3" aria-hidden="true" />
                    Add
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      <p className="m-0 text-[0.6875rem] font-semibold text-muted-foreground">Drag a card to any slot, or click it for “Move to…” — both do the same thing.</p>
    </>
  );
}
