import { Link } from "@tanstack/react-router";
import { CalendarRange, ChevronRight, Dices, Plus } from "lucide-react";
import type { PlanDay, PlanRecipeEntry, PlanWeek } from "#/lib/api";
import { MEAL_SLOTS, type PlanDate } from "#/lib/plan/week";
import { formatPlanDate, shortDow } from "#/lib/plan/labels";
import { Button } from "#/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip";

/**
 * "Coming up this week" — the pantry home's glance at the meal plan.
 *
 * Presentational: it takes a `PlanWeek` exactly as `getMealPlanWeek` returns it
 * and derives every string from that payload. No fetching, no mutation, no
 * optimistic anything — the planner at `/household/plan` owns all of that, and
 * this card's only job is to be a good enough summary that you do not have to
 * open it.
 *
 * **Labels come from `lib/plan/labels.ts`, never from `toLocaleDateString`.** The
 * planner's labels are deliberately locale-free and UTC-anchored so the server
 * and the browser render the same bytes; a second, prettier date formatter here
 * would hydrate differently per machine and would drift a day for anyone east of
 * the household's timezone.
 *
 * **One row per upcoming day, not per entry.** A household that plans breakfast,
 * lunch and dinner has 21 entries in a week, and 21 rows is the planner, not a
 * glance. Each row shows the day's first live recipe entry in slot order and
 * counts the rest as "+N more" — a real number off the payload, not a guess.
 * Days already in the past are skipped: "coming up" means coming up.
 *
 * **The meta line only says what the payload knows.** The comp reads
 * `35 min · 4 servings · planned by Dana`; `PlanRecipeEntry` carries a total time
 * and an adder handle but no servings, so the servings segment is dropped rather
 * than faked. Same rule for the whole card.
 *
 * The "empty" branch is not "no entries in the payload" — it is "nothing left to
 * come". A week whose only meals were cooked on Monday is, on Thursday, an empty
 * week as far as this card is concerned, and it says so and offers the planner.
 */

export interface WeekAheadCardProps {
  /** The week as `getMealPlanWeek` returns it — already snapped and timezone-anchored. */
  week: PlanWeek;
  /** How many planned days to draw before the card stops. Default 3. */
  maxDays?: number;
  className?: string;
}

/** One drawn row: a day, the meal standing in for it, and how many it hides. */
interface DayRow {
  date: PlanDate;
  dayLabel: string;
  isToday: boolean;
  entry: PlanRecipeEntry;
  /** Live recipe entries on that day beyond the one shown. */
  moreCount: number;
}

/** Live recipe entries for a day, in canonical slot order (notes are not meals). */
function recipeEntriesFor(day: PlanDay): PlanRecipeEntry[] {
  return MEAL_SLOTS.flatMap((slot) => day.slots[slot]).filter((entry): entry is PlanRecipeEntry => entry.kind === "recipe");
}

export function WeekAheadCard({ week, maxDays = 3, className }: WeekAheadCardProps) {
  const upcoming = week.days.filter((day) => day.date >= week.today);

  const rows: DayRow[] = [];
  for (const day of upcoming) {
    const entries = recipeEntriesFor(day);
    if (entries.length === 0) continue;
    // "Tonight" is the comp's word for today, and it is only true when the meal
    // standing in for today is the evening one. A household whose next planned
    // thing today is breakfast gets "Today" instead of a card that lies by a
    // dozen hours.
    const isDinner = day.slots.dinner.some((entry) => entry.id === entries[0].id);
    rows.push({
      date: day.date,
      dayLabel: day.isToday ? (isDinner ? "Tonight" : "Today") : shortDow(day.date),
      isToday: day.isToday,
      entry: entries[0],
      moreCount: entries.length - 1,
    });
    if (rows.length === maxDays) break;
  }

  // The comp's trailing "Nothing planned yet." row — the next bare day *after*
  // everything drawn above, so it reads as the edge of the plan rather than a
  // hole in it. Absent when the shown days run to the end of the week.
  const lastShown = rows.at(-1)?.date;
  const nextBareDay = lastShown ? (upcoming.find((day) => day.date > lastShown && recipeEntriesFor(day).length === 0) ?? null) : null;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="flex items-center gap-2 text-xl leading-[1.1] font-bold">
          <CalendarRange className="size-5" aria-hidden="true" />
          Coming up this week
        </CardTitle>
        <CardAction>
          <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/household/plan" />}>
            Open the planner
            <ChevronRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent>
        {rows.length === 0 ? (
          <EmptyWeek />
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {rows.map((row) => (
              <PlannedRow key={row.date} row={row} weekStart={week.weekStart} />
            ))}
            {nextBareDay ? <BareDayRow date={nextBareDay.date} /> : null}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** The 4.5rem leading column: day word over date, both muted, both micro-type. */
function DayColumn({ day, date }: { day: string; date: PlanDate }) {
  return (
    <div className="w-18 flex-none">
      <div className="text-xs font-bold tracking-[0.06em] text-muted-foreground uppercase">{day}</div>
      <div className="text-[0.8125rem] text-muted-foreground">{formatPlanDate(date)}</div>
    </div>
  );
}

const ROW = "flex items-center gap-4 border-t border-border/60 py-3";

function PlannedRow({ row, weekStart }: { row: DayRow; weekStart: PlanDate }) {
  const { entry } = row;
  const meta = [entry.totalTimeDisplay, entry.addedByHandle ? `planned by ${entry.addedByHandle}` : null, row.moreCount > 0 ? `+${row.moreCount} more` : null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <li className={ROW}>
      <DayColumn day={row.dayLabel} date={row.date} />
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-foreground text-pretty">{entry.title}</div>
        {meta ? <div className="text-[0.8125rem] text-muted-foreground">{meta}</div> : null}
      </div>
      <RowAction row={row} weekStart={weekStart} />
    </li>
  );
}

/**
 * Tonight cooks, the rest of the week views — and an entry whose recipe has since
 * left the box goes to the planner instead, because `/household/recipes/$id` is a
 * box-scoped page and would 404 on it. Every label names its meal for anyone
 * meeting these buttons as a list; the visible word stays the leading substring
 * of the accessible name (WCAG 2.5.3).
 */
function RowAction({ row, weekStart }: { row: DayRow; weekStart: PlanDate }) {
  const { entry } = row;

  if (!entry.inBox) {
    return (
      <Button variant="ghost" size="sm" nativeButton={false} aria-label={`View ${entry.title} on the plan`} render={<Link to="/household/plan" search={{ week: weekStart }} />}>
        View
      </Button>
    );
  }

  // `?cook` is the app's one deep link into the apron (meal planner §7.5) — the
  // same param `routes/household.recipes.$id.tsx` reads and then drops.
  if (row.isToday) {
    return (
      <Button
        variant="ghost"
        size="sm"
        nativeButton={false}
        aria-label={`Cook ${entry.title}`}
        render={<Link to="/household/recipes/$id" params={{ id: entry.recipeId }} search={{ cook: true }} />}
      >
        Cook
      </Button>
    );
  }

  return (
    <Button variant="ghost" size="sm" nativeButton={false} aria-label={`View ${entry.title}`} render={<Link to="/household/recipes/$id" params={{ id: entry.recipeId }} />}>
      View
    </Button>
  );
}

function BareDayRow({ date }: { date: PlanDate }) {
  return (
    <li className={ROW}>
      <DayColumn day={shortDow(date)} date={date} />
      <div className="min-w-0 flex-1 text-sm text-muted-foreground">Nothing planned yet.</div>
      <Button
        variant="outline"
        size="sm"
        nativeButton={false}
        aria-label={`Plan a recipe for ${formatPlanDate(date)}`}
        render={<Link to="/household/plan" search={{ week: date }} />}
      >
        <Plus data-icon="inline-start" aria-hidden="true" />
        Plan a recipe
      </Button>
    </li>
  );
}

function EmptyWeek() {
  return (
    <div className="flex flex-col items-start gap-4 rounded-lg border-2 border-border/60 bg-muted/45 p-5">
      {/* Three empty nights, drawn. Decoration only — the paragraph says it. */}
      <div className="flex gap-2" aria-hidden="true">
        {[0, 1, 2].map((slot) => (
          <div key={slot} className="h-12 w-10 rounded-[min(var(--radius-md),10px)] border-2 border-dashed border-border/60" />
        ))}
      </div>
      <p className="m-0 text-sm text-muted-foreground text-pretty">
        Nothing on the plan for this week. Lay the week out on the table before it starts — pick a few nights from your box and the rest of the week gets easier.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="lg" nativeButton={false} render={<Link to="/household/plan" />}>
          <CalendarRange data-icon="inline-start" aria-hidden="true" />
          Plan this week
        </Button>
        {/*
          The randomizer is a `soon` chip in the nav, not a feature, and a button
          that silently does nothing is worse than one that says so.
          `focusableWhenDisabled` renders `aria-disabled` instead of the native
          attribute, so the control still takes focus and still fires hover —
          which is the only way its tooltip is ever readable. Base UI suppresses
          the click either way. Same construction as the shopping-list button in
          `components/plan/ThisWeekPanel.tsx`; do not fork it.
        */}
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="lg" disabled focusableWhenDisabled className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50" />}>
            <Dices data-icon="inline-start" aria-hidden="true" />
            Surprise me
          </TooltipTrigger>
          <TooltipContent>The randomizer isn’t built yet. When it is, you’ll roll the dice and dinner picks itself.</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
