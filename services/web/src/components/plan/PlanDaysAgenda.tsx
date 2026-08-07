import { Fragment, useCallback, useLayoutEffect, useRef } from "react";
import { ChevronUp, Plus } from "lucide-react";
import type { PlanWeek } from "#/server/meal-plan";
import { MEAL_SLOTS } from "#/lib/plan/week";
import { SLOT_LABELS, addToSlotLabel, formatPlanDate, longDow } from "#/lib/plan/labels";
import { Badge } from "#/components/ui/badge";
import { PlanEntryCard } from "./PlanEntryCard";
import { slotDropHandlers, slotKey, usePlanActions } from "./PlanActions";
import { useIsMobile } from "#/lib/hooks/use-mobile";
import { cn } from "#/lib/utils";

/** Frames the scroll keeps re-asserting itself after a week loads — roughly a
 * third of a second, enough to outlast a font swap or a late reflow, short
 * enough that it is over before anyone reaches the screen to scroll. */
const SETTLE_FRAMES = 20;

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
export function PlanDaysAgenda({ week, scrollNonce = 0 }: { week: PlanWeek; scrollNonce?: number }) {
  const actions = usePlanActions();
  const isMobile = useIsMobile();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const firstDayRef = useRef<HTMLElement>(null);

  /**
   * On a phone the agenda opens on today, not on Monday: days already eaten are
   * scrolled off the top, with a chip to go back for them.
   *
   * The chip only exists when today is in the visible week AND is not its first
   * day — which makes it, by construction, a this-week-only affordance: past and
   * future weeks have no `isToday`, and a week whose first day is today has
   * nothing above to scroll to.
   */
  const todayIndex = week.days.findIndex((day) => day.isToday);
  const showAnchor = todayIndex > 0;

  /**
   * The breathing room above the parked chip is the chip's own `scroll-mt-3` —
   * `block: "start"` honours scroll margin, so the offset is a class rather than
   * arithmetic here. Walking up to other scrollable ancestors isn't a concern:
   * the agenda's box is the only one on this page, since the shell sizes itself
   * to the viewport and the document never scrolls.
   */
  const scrollToAnchor = useCallback((behavior: ScrollBehavior) => {
    anchorRef.current?.scrollIntoView({ block: "start", behavior });
  }, []);

  /** Scroll 0, not "the first day card": above it sits the empty-week banner,
   * which scrolling to the card would push out of sight on exactly the weeks
   * that need it most. */
  const scrollToTop = useCallback((behavior: ScrollBehavior) => {
    firstDayRef.current?.parentElement?.scrollTo({ top: 0, behavior });
  }, []);

  /**
   * Every week change parks the list somewhere deliberate: on today's chip when
   * there is one, otherwise at the top — never at whatever offset the week you
   * just left happened to be scrolled to.
   *
   * The scroll can't be a single write. A layout effect runs against a DOM that
   * is committed but not settled: web fonts swap in and entry cards reflow, each
   * moving the chip out from under wherever we just parked. So the write repeats
   * every frame for
   * `SETTLE_FRAMES`. Deliberately not "stop once the offset holds still": the
   * offset holds still between reflows too, and bailing on the first quiet pair
   * of frames leaves the agenda parked a few pixels off whatever lands next.
   *
   * Repeating also survives a background tab, where `requestAnimationFrame` is
   * throttled to seconds or never fires at all: the first write is synchronous,
   * so the agenda is already parked before any frame is granted.
   *
   * A hand scroll ends it immediately — past that point the offset is the user's,
   * not ours.
   *
   * `scrollNonce` is what makes "Today" work when the week on screen already is
   * this week: nothing else in the deps changes, so without it the effect never
   * re-runs.
   *
   * `instant`, not smooth: this is the first frame of a week, and animating it
   * reads as the page moving on its own.
   */
  useLayoutEffect(() => {
    const box = firstDayRef.current?.parentElement;
    if (!box) return;

    const run = () => (isMobile && showAnchor ? scrollToAnchor("instant") : scrollToTop("instant"));
    run();

    let frame = 0;
    let frames = 0;
    const tick = () => {
      run();
      if (++frames >= SETTLE_FRAMES) return;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    const stop = () => cancelAnimationFrame(frame);
    box.addEventListener("wheel", stop, { passive: true });
    box.addEventListener("touchstart", stop, { passive: true });
    return () => {
      stop();
      box.removeEventListener("wheel", stop);
      box.removeEventListener("touchstart", stop);
    };
  }, [isMobile, scrollToAnchor, scrollToTop, showAnchor, week.weekStart, scrollNonce]);

  return (
    <>
      {week.days.map((day, index) => (
        <Fragment key={day.date}>
          {showAnchor && index === todayIndex && (
            <button
              ref={anchorRef}
              type="button"
              onClick={() => scrollToTop("smooth")}
              className="-mb-1 inline-flex shrink-0 scroll-mt-3 items-center gap-1 self-center rounded-4xl border-2 border-dashed border-border/45 px-2.5 py-1 text-[0.6875rem] font-bold text-muted-foreground hover:border-border hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:hidden"
            >
              <ChevronUp className="size-3" aria-hidden="true" />
              See previous days
            </button>
          )}
          <section
            ref={index === 0 ? firstDayRef : undefined}
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
        </Fragment>
      ))}

      <p className="m-0 text-[0.6875rem] font-semibold text-muted-foreground">Drag a card to any slot, or click it for “Move to…” — both do the same thing.</p>
    </>
  );
}
