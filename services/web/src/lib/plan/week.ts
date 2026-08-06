// dayjs + the utc/timezone plugins. The repo imports plugin subpaths with an
// explicit `.js` everywhere (Node's native ESM resolver needs it in the cron
// service, and keeping one style avoids two conventions for the same import).
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezonePlugin from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezonePlugin);

/**
 * Week + date math for the meal planner. See
 * `docs/plans/2026-08-06-meal-planner.md` §5.
 *
 * Pure and dependency-light: no DB, no session, no React. Every function takes
 * its inputs explicitly (including `weekStartDay` and `timezone`, which come
 * from `household_preference`) so the same code runs on the server, in the
 * loader, and in the browser and always agrees.
 *
 * The load-bearing rule (§2.3): a planned meal is a CALENDAR DATE, not an
 * instant. Dates cross every boundary — URL, server-fn args, JSON, the `date`
 * column — as a `YYYY-MM-DD` string, and all arithmetic below is done in UTC so
 * the host machine's zone can never shift a date by a day. The household
 * timezone is used for exactly one thing here: deciding what "today" is.
 */

export type MealSlot = "breakfast" | "lunch" | "dinner" | "snack";

/** Canonical display order — the grid's four rows, top to bottom. */
export const MEAL_SLOTS: readonly MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];

export function isMealSlot(value: unknown): value is MealSlot {
  return typeof value === "string" && (MEAL_SLOTS as readonly string[]).includes(value);
}

/** ISO calendar date, "YYYY-MM-DD". Never a Date object across a boundary. */
export type PlanDate = string;

const DATE_FMT = "YYYY-MM-DD";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True when `raw` is a well-formed AND real calendar date.
 *
 * The regex alone accepts "2026-02-31". dayjs would happily roll that forward
 * to March 3rd and report `isValid()`, so the real check is the round trip:
 * re-printing must reproduce the input exactly. (Deliberately no
 * `customParseFormat` plugin — the round trip subsumes strict parsing here.)
 */
export function isPlanDate(raw: unknown): raw is PlanDate {
  if (typeof raw !== "string" || !DATE_RE.test(raw)) return false;
  const d = dayjs.utc(raw);
  return d.isValid() && d.format(DATE_FMT) === raw;
}

/** Parse a `PlanDate` to a UTC dayjs. Throws on anything malformed — callers at
 * a trust boundary validate first with `isPlanDate` / `parseWeekParam`. */
function at(date: PlanDate): dayjs.Dayjs {
  if (!isPlanDate(date)) throw new Error(`invalid PlanDate: ${JSON.stringify(date)}`);
  return dayjs.utc(date);
}

/**
 * Snap any date to the start of its week under `weekStartDay`
 * (ISO-8601 numbering: 1 = Monday … 7 = Sunday).
 *
 * Changing `week_start_day` never migrates data — entries are keyed by date, so
 * a different snap point simply re-buckets the same rows into a different grid.
 */
export function weekStartFor(date: PlanDate, weekStartDay: number): PlanDate {
  const start = normalizeWeekStartDay(weekStartDay);
  const d = at(date);
  // dayjs `.day()` is 0=Sun…6=Sat; convert to ISO 1=Mon…7=Sun.
  const iso = d.day() === 0 ? 7 : d.day();
  // How many days back to the most recent `start`. Always in 0…6.
  const back = (iso - start + 7) % 7;
  return d.subtract(back, "day").format(DATE_FMT);
}

/** Clamp an untrusted week-start day into 1…7, falling back to Monday. */
export function normalizeWeekStartDay(weekStartDay: number): number {
  return Number.isInteger(weekStartDay) && weekStartDay >= 1 && weekStartDay <= 7 ? weekStartDay : 1;
}

/** The 7 dates of the week beginning `weekStart`, in order. */
export function weekDates(weekStart: PlanDate): PlanDate[] {
  const d = at(weekStart);
  return Array.from({ length: 7 }, (_, i) => d.add(i, "day").format(DATE_FMT));
}

/**
 * "Today" as a calendar date in the household timezone. An unknown zone falls
 * back to UTC rather than throwing — a bad stored value must not take down the
 * whole plan page. (Writes are validated against `Intl.supportedValuesOf`, so
 * this is a belt-and-braces path.)
 */
export function todayIn(timezone: string): PlanDate {
  try {
    return dayjs().tz(timezone).format(DATE_FMT);
  } catch {
    return dayjs.utc().format(DATE_FMT);
  }
}

/** ±n weeks from a week start. */
export function shiftWeeks(weekStart: PlanDate, n: number): PlanDate {
  return at(weekStart)
    .add(n * 7, "day")
    .format(DATE_FMT);
}

/** Inclusive day offset from `from` to `to` — used to map an entry onto the
 * same weekday of another week when copying. */
export function daysBetween(from: PlanDate, to: PlanDate): number {
  return at(to).diff(at(from), "day");
}

/** Shift a single date by `n` days. */
export function shiftDays(date: PlanDate, n: number): PlanDate {
  return at(date).add(n, "day").format(DATE_FMT);
}

/**
 * Parse + validate a `?week=` param; returns null when malformed (missing,
 * wrong shape, or not a real date). Callers re-snap the result with
 * `weekStartFor` — this deliberately does NOT snap, so the server owns that
 * step and a client cannot pin the grid to a mid-week offset (§5).
 */
export function parseWeekParam(raw: string | undefined): PlanDate | null {
  return isPlanDate(raw) ? raw : null;
}
