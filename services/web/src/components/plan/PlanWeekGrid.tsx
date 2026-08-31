import { Plus } from "lucide-react";
import type { PlanWeek } from "#/lib/api";
import { MEAL_SLOTS } from "#/lib/plan/week";
import { SLOT_LABELS, addToSlotLabel, formatPlanDate, shortDow } from "#/lib/plan/labels";
import { Badge } from "#/components/ui/badge";
import { PlanEntryCard } from "./PlanEntryCard";
import { OFFLINE_WRITE_HINT } from "#/lib/offline/use-online";
import { slotDropHandlers, slotKey, usePlanActions } from "./PlanActions";
import { cn } from "#/lib/utils";

/**
 * The week view: 7 day columns × 4 slot rows, the planner's default layout on a
 * tablet and up.
 *
 * The grid fills its container and compresses down to a 46rem floor rather than
 * being pinned at the comp's 60rem: at 60rem every laptop narrower than ~1360px
 * (or any width at all with the "This week" panel docked) got a horizontal
 * scrollbar, which is not what the comp is trying to say. 46rem is the width at
 * which a day column is still ~93px — two clamped lines of the 11px card title,
 * the date, the today chip and the dashed add button all still fit — and it is
 * comfortably under the `md` breakpoint, where D16 hands over to the days
 * agenda anyway. Above 46rem the columns just grow; the layout is identical to
 * the comp at the comp's width. One CSS grid spans the whole table, so slot rows
 * stay aligned across every column; the outer chrome is the 2px brand border and
 * the interior rules are the lighter 1px `border/45`, exactly as drawn.
 *
 * The container deliberately does NOT have `overflow-hidden` — the entry
 * popovers are portalled now, but an `overflow` ancestor would still clip the
 * focus rings and re-introduce the class of bug this grid caused. The four
 * corner cells round themselves instead, which is what `overflow-hidden` was
 * there to fake. They read `--cell-radius` off the container rather than
 * hardcoding a pixel value: a cell sits in the padding box, so its corner has to
 * match the border's *inner* curve (the `rounded-xl` radius minus the 2px
 * border) or its square-ish corner paints over the border along the arc.
 *
 * The last column and the last row deliberately skip their trailing hairline —
 * the container's 2px border already closes the table there, and a 1px rule
 * flush against it just reads as a smudged edge.
 *
 * Every cell is a drop target (D14). The drag itself starts on the card; the
 * cell only decides whether to accept it and paints the accent wash while the
 * pointer is over it.
 */
export function PlanWeekGrid({ week }: { week: PlanWeek }) {
  const actions = usePlanActions();

  return (
    <>
      {/* Deliberately NOT role="grid": the layout needs `display: contents` row
          wrappers, which browsers drop from the accessibility tree, so grid roles
          here would describe rows assistive tech never sees. Cell contents name
          themselves instead — the add buttons say "Add to dinner on Aug 5", the
          cards carry their own slot and date. */}
      <div
        role="region"
        aria-label={`Meal plan, week of ${formatPlanDate(week.weekStart)}`}
        className="grid w-full min-w-[46rem] shrink-0 grid-cols-[86px_repeat(7,minmax(0,1fr))] rounded-xl border-2 border-border bg-card shadow-pop-md [--cell-radius:calc(var(--radius-xl)-2px)]"
      >
        {/* Header row: the empty corner above the slot labels, then the days. */}
        <div className="rounded-tl-(--cell-radius) border-r-2 border-r-border border-b-2 border-b-border bg-muted" />
        {week.days.map((day, index) => (
          <div
            key={day.date}
            className={cn(
              "border-b-2 border-b-border px-[7px] py-[5px]",
              index === week.days.length - 1 ? "rounded-tr-(--cell-radius)" : "border-r border-r-border/45",
              day.isToday ? "bg-secondary text-secondary-foreground" : day.isPast ? "bg-muted/60" : "bg-card",
            )}
          >
            <div className={cn("text-[0.625rem] font-bold tracking-wide uppercase", day.isToday ? "text-secondary-foreground/70" : "text-muted-foreground")}>
              {shortDow(day.date)}
            </div>
            <div className="flex min-w-0 items-center gap-[5px]">
              <span className="text-sm font-bold whitespace-nowrap">{formatPlanDate(day.date)}</span>
              {day.isToday && (
                <Badge variant="secondary" size="xs">
                  today
                </Badge>
              )}
            </div>
          </div>
        ))}

        {MEAL_SLOTS.map((slot, slotIndex) => (
          <div key={slot} className="contents">
            <div
              className={cn(
                "border-r-2 border-r-border bg-muted px-1.5 py-[7px]",
                slotIndex === MEAL_SLOTS.length - 1 ? "rounded-bl-(--cell-radius)" : "border-b border-b-border/45",
              )}
            >
              <div className="text-[0.625rem] font-bold tracking-wide break-words text-muted-foreground uppercase">{SLOT_LABELS[slot]}</div>
            </div>
            {week.days.map((day, index) => (
              <div
                key={`${day.date}-${slot}`}
                data-plan-slot=""
                {...slotDropHandlers(actions, day.date, slot)}
                className={cn(
                  "flex min-h-[62px] flex-col gap-1 p-[5px]",
                  index !== week.days.length - 1 && "border-r border-r-border/45",
                  slotIndex !== MEAL_SLOTS.length - 1 && "border-b border-b-border/45",
                  slotIndex === MEAL_SLOTS.length - 1 && index === week.days.length - 1 && "rounded-br-(--cell-radius)",
                  actions.dragOverSlot === slotKey(day.date, slot) ? "bg-accent" : day.isToday ? "bg-secondary/40" : day.isPast ? "bg-muted/45" : "bg-card",
                )}
              >
                {day.slots[slot].map((entry) => (
                  <PlanEntryCard key={entry.id} entry={entry} date={day.date} slot={slot} variant="grid" isPast={day.isPast} />
                ))}
                <button
                  type="button"
                  data-plan-add=""
                  disabled={!actions.writable}
                  onClick={() => actions.openAdd(day.date, slot)}
                  title={actions.writable ? addToSlotLabel(slot, day.date) : OFFLINE_WRITE_HINT}
                  aria-label={addToSlotLabel(slot, day.date)}
                  className="mt-auto flex w-full items-center justify-center gap-1 rounded-sm border-2 border-dashed border-border/45 py-0.5 text-[0.625rem] font-bold text-muted-foreground hover:border-border hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
                >
                  <Plus className="size-3" aria-hidden="true" />
                  {day.slots[slot].length === 0 && "Add"}
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>

      <p className="m-0 text-[0.6875rem] font-semibold text-muted-foreground">Drag a card to any slot, or click it for “Move to…” — both do the same thing.</p>
    </>
  );
}
