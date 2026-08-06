import { isPlanDate, type MealSlot, type PlanDate } from "./week";

/**
 * Display labels for the meal planner — the copy strings the design comp derives
 * ("Aug 3", "Wed", "Dinner · Wed, Aug 5", "Add to dinner on Aug 5").
 *
 * Pure and client-safe, and deliberately NOT locale-aware: every label is built
 * from fixed English tables and UTC arithmetic over the `YYYY-MM-DD` string, so
 * the server render and the client render always produce the same bytes (a
 * `toLocaleDateString` here would hydrate differently per machine locale) and a
 * date can never slip a day through the host timezone. The planner's copy is
 * English-only today; when it isn't, this is the one file that changes.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Indexed 0 = Monday … 6 = Sunday (ISO order, not JS's Sunday-first). */
const DOW_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DOW_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Slot key → the design's Title Case row/menu label. */
export const SLOT_LABELS: Record<MealSlot, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
};

function parts(date: PlanDate): { month: number; day: number; dow: number } | null {
  if (!isPlanDate(date)) return null;
  const [y, m, d] = date.split("-").map(Number);
  // UTC on purpose: `new Date("2026-08-03")` is already UTC-midnight, but going
  // through Date.UTC makes that explicit and immune to a local-time reading.
  const jsDow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { month: m - 1, day: d, dow: (jsDow + 6) % 7 };
}

/** "2026-08-03" → "Aug 3". Malformed input is echoed rather than thrown on. */
export function formatPlanDate(date: PlanDate): string {
  const p = parts(date);
  return p ? `${MONTHS[p.month]} ${p.day}` : date;
}

/** "2026-08-03" → "Mon". */
export function shortDow(date: PlanDate): string {
  const p = parts(date);
  return p ? DOW_SHORT[p.dow] : "";
}

/** "2026-08-03" → "Monday". */
export function longDow(date: PlanDate): string {
  const p = parts(date);
  return p ? DOW_LONG[p.dow] : "";
}

/**
 * ISO weekday number → name (1 = Monday … 7 = Sunday) — the "Week starts" select
 * and the panel's "Monday start · UTC" line. Takes the number rather than a date
 * because `week_start_day` is stored as one.
 */
export function weekdayName(isoDay: number): string {
  return DOW_LONG[isoDay - 1] ?? DOW_LONG[0];
}

/** The toolbar's week label: "Aug 3 – Aug 9" (en dash, as drawn). */
export function weekRangeLabel(weekStart: PlanDate, weekEnd: PlanDate): string {
  return `${formatPlanDate(weekStart)} – ${formatPlanDate(weekEnd)}`;
}

/** The entry popover's header line: "Dinner · Wed, Aug 5". */
export function slotDayLine(slot: MealSlot, date: PlanDate): string {
  return `${SLOT_LABELS[slot]} · ${shortDow(date)}, ${formatPlanDate(date)}`;
}

/** The add button's accessible name: "Add to dinner on Aug 5". */
export function addToSlotLabel(slot: MealSlot, date: PlanDate): string {
  return `Add to ${slot} on ${formatPlanDate(date)}`;
}
