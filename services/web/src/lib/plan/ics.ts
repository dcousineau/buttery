// dayjs + the utc/timezone plugins. Plugin subpaths carry an explicit `.js`
// everywhere in this repo — see the note at the top of `./week.ts`.
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezonePlugin from "dayjs/plugin/timezone.js";
import { SLOT_LABELS } from "./labels";
import { MEAL_SLOTS, type MealSlot, type PlanDate } from "./week";

dayjs.extend(utc);
dayjs.extend(timezonePlugin);

/**
 * `.ics` (iCalendar, RFC 5545) serialization for one planned week. See
 * `docs/plans/2026-08-06-meal-planner.md` §9.3.
 *
 * PURE: no DB, no session, no React, no `Request`. Everything it needs — the
 * week's entries, the household timezone, the slot labels and times, the site
 * origin, and even "now" — arrives as an argument, so the whole format is unit
 * testable without HTTP and a test can pin `DTSTAMP`.
 *
 * The shape of the calendar (§9.3, plus the export refinements recorded in the
 * results doc):
 *   - one `VEVENT` per RECIPE entry;
 *   - `SUMMARY` is prefixed with the slot's UI label — "Dinner: Roast chicken";
 *   - notes are folded into the `DESCRIPTION` of their slot's events, and a
 *     slot holding only notes produces ONE event titled by the slot;
 *   - `DESCRIPTION` leads with the labelled Buttery link ("Buttery: https://…"),
 *     then the recipe's original source link when it has an http(s) one
 *     ("Source: https://…"), then the slot's notes;
 *   - `UID` is derived from the entry id, so re-importing the same week updates
 *     the existing events instead of duplicating them;
 *   - each slot has a default local time in the household timezone, converted
 *     to a UTC `Z` stamp. Converting up front is what lets us ship a calendar
 *     with no `VTIMEZONE` block at all;
 *   - an event lasts as long as its recipe's total time (clamped), falling back
 *     to the per-slot default when the recipe has no time on it.
 */

// --- input shapes -------------------------------------------------------

/**
 * The entry fields the calendar actually needs. Deliberately structural rather
 * than an import of `server/meal-plan`'s `PlanEntry`: `lib/` must not depend on
 * `server/`, and a `PlanWeek` satisfies these types as-is.
 */
export type IcsEntry =
  | {
      id: string;
      kind: "recipe";
      recipeId: string;
      title: string;
      /**
       * The recipe's total time in minutes, when it has one. Drives `DTEND`.
       * `PlanRecipeEntry` exposes this alongside the `totalTimeDisplay` string
       * the UI renders; the calendar wants the number, never the prose.
       */
      totalMinutes?: number | null;
      /**
       * Provenance (`PlanRecipeEntry.source`). Only `url` is read, and only
       * when it turns out to be an http(s) URL — see `httpUrl`. Sources that
       * are just a label ("Handwritten in your box") carry `url: null`.
       */
      source?: { url?: string | null } | null;
    }
  | { id: string; kind: "note"; body: string };

export interface IcsDay {
  date: PlanDate;
  /** All four slots, in any order — this module iterates `MEAL_SLOTS`. */
  slots: Record<MealSlot, IcsEntry[]>;
}

/** Structurally satisfied by `PlanWeek`. */
export interface IcsWeek {
  weekStart: PlanDate;
  weekEnd: PlanDate;
  /** IANA zone the slot times below are interpreted in. */
  timezone: string;
  days: IcsDay[];
}

export interface BuildWeekIcsOptions {
  /** Absolute site origin, used to build the recipe link in `DESCRIPTION`. */
  siteUrl?: string;
  /** Generation instant for `DTSTAMP`. Injectable so tests are deterministic. */
  now?: Date;
  /** Display labels for each slot. Defaults to `SLOT_LABELS`. */
  slotLabels?: Record<MealSlot, string>;
  /** Local start times per slot, `HH:mm`. Defaults to `SLOT_TIMES`. */
  slotTimes?: Record<MealSlot, string>;
  /**
   * FALLBACK event length in minutes, used for an entry with no total time (and
   * for a note-only slot). An entry that HAS a total time is timed from it.
   * Defaults to `SLOT_DURATION_MINUTES`.
   */
  durationMinutes?: number;
}

// --- constants ----------------------------------------------------------

/**
 * Per-slot default LOCAL start times in the household timezone (§9.3). One
 * constant table, ready to be promoted to `household_preference` the first time
 * anyone asks for it. All are comfortably clear of any DST spring-forward gap.
 */
export const SLOT_TIMES: Record<MealSlot, string> = {
  breakfast: "08:00",
  lunch: "12:30",
  dinner: "18:30",
  snack: "15:00",
};

/**
 * Fallback event length for an entry with no total time — a note, or a recipe
 * nobody has timed. It is a placeholder ("there is a meal here"), not a claim
 * about how long cooking takes.
 */
export const SLOT_DURATION_MINUTES = 30;

/**
 * Floor and ceiling on a duration derived from `totalMinutes`.
 *
 * `total_time_seconds` is scraped or synced, so it is not ours to trust: a
 * 2-minute "recipe" would import as a sliver most calendar UIs render
 * unreadably, and a 3-day fermentation would paint over the rest of the week.
 * Clamping keeps a hostile or merely enthusiastic number from making the
 * calendar useless, and both bounds are generous enough that a real recipe's
 * time survives untouched.
 */
export const MIN_DURATION_MINUTES = 15;
export const MAX_DURATION_MINUTES = 8 * 60;

/**
 * Human labels; the event `SUMMARY` reads "Dinner: Chicken Tikka Masala".
 * Re-exported from `./labels` rather than redeclared, so the calendar and the
 * grid can never drift apart on what a slot is called.
 */
export { SLOT_LABELS };

/** RFC 5545 §3.7.3 — `-//<vendor>//<product>//<language>`. */
export const PRODID = "-//Buttery//Meal Planner//EN";

/** `UID` namespace. Stable forever: changing it turns every re-import into a duplicate. */
const UID_DOMAIN = "buttery.app";

const CRLF = "\r\n";
/** RFC 5545 §3.1: content lines SHOULD NOT exceed 75 octets, excluding the CRLF. */
const MAX_OCTETS = 75;

const encoder = new TextEncoder();

// --- primitives ---------------------------------------------------------

function octets(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Escape a TEXT value (RFC 5545 §3.3.11): backslash, semicolon and comma are
 * escaped, and any newline becomes a literal `\n`. Backslash MUST go first or
 * the escapes we add would themselves get escaped.
 *
 * A lone CR is dropped rather than escaped — CRLF and CR both mean "one line
 * break", and emitting a raw CR into a content line would corrupt the file.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\n|\r/g, "\\n");
}

/**
 * Fold one content line to 75 octets (RFC 5545 §3.1). Continuation lines begin
 * with a single space, which counts toward their 75, so they carry 74 octets of
 * payload.
 *
 * Iteration is by code point (`for…of` on a string), never by UTF-16 unit, so a
 * fold can never land inside an astral character's surrogate pair or split a
 * multi-byte sequence.
 */
export function foldLine(line: string): string {
  if (octets(line) <= MAX_OCTETS) return line;
  const parts: string[] = [];
  let current = "";
  let used = 0;
  let limit = MAX_OCTETS;
  for (const ch of line) {
    const size = octets(ch);
    if (used + size > limit) {
      parts.push(current);
      current = "";
      used = 0;
      // Every line after the first spends one octet on its leading space.
      limit = MAX_OCTETS - 1;
    }
    current += ch;
    used += size;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

/** `name:value`, escaped and folded. */
function textProperty(name: string, value: string): string {
  return foldLine(`${name}:${escapeText(value)}`);
}

/**
 * A UTC `DATE-TIME` stamp (`20260806T183000Z`) for a local wall-clock time in
 * `timezone`. An unknown zone falls back to UTC instead of throwing — the same
 * fail-soft rule `todayIn` uses, because one bad stored preference must not
 * make the download 500.
 */
export function utcStamp(date: PlanDate, time: string, timezone: string, addMinutes = 0): string {
  const local = `${date}T${time}`;
  let instant: dayjs.Dayjs;
  try {
    instant = dayjs.tz(local, timezone);
    if (!instant.isValid()) throw new Error("invalid");
  } catch {
    instant = dayjs.utc(local);
  }
  return instant.add(addMinutes, "minute").utc().format("YYYYMMDD[T]HHmmss[Z]");
}

function stampFrom(value: Date): string {
  return dayjs.utc(value).format("YYYYMMDD[T]HHmmss[Z]");
}

/** `<entryId>@buttery.app` — stable per entry, so re-import updates in place. */
export function entryUid(entryId: string): string {
  return `${entryId}@${UID_DOMAIN}`;
}

/** Suggested download filename for a week, e.g. `buttery-meal-plan-2026-08-03.ics`. */
export function icsFilename(weekStart: PlanDate): string {
  return `buttery-meal-plan-${weekStart}.ics`;
}

// --- builder ------------------------------------------------------------

function recipeUrl(siteUrl: string, recipeId: string): string {
  const origin = siteUrl.replace(/\/+$/, "");
  // `encodeURI` leaves the characters legal in a path segment (`:`, `~`, `.`,
  // `_`, `-` — every character an atproto rkey may contain) untouched.
  return encodeURI(`${origin}/recipes/${recipeId}`);
}

/**
 * A recipe's ORIGINAL source link, if and only if it really is one.
 *
 * `RecipeSource.url` comes from scraped attribution and synced atproto records,
 * so the scheme is validated rather than assumed: a `javascript:` or `data:`
 * value must never be handed to a calendar client as a clickable link, and a
 * source that is only a label ("Handwritten in your box") carries a null url and
 * simply produces no line.
 *
 * Returns the parsed `href`, so what lands in the file is a normalized URL —
 * the `URL` parser also strips the tabs and newlines that would otherwise be a
 * content-line injection vector. Everything legal that survives (`,` `;` in a
 * path are both legal sub-delimiters) is still escaped by `escapeText` on the
 * way out.
 */
export function httpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href;
}

/**
 * How long one event runs. The recipe's own total time when it has one, the
 * caller's per-slot fallback when it does not, clamped either way.
 *
 * Note there is no "several recipes in one slot" rule to make: §9.3 emits one
 * `VEVENT` PER RECIPE ENTRY, so a household cooking two dishes for one dinner
 * gets two events that start together and each run their own length. That is
 * the right answer to the overlap question — two dishes cooked side by side take
 * the longer of the two, not the sum, and two concurrent events say exactly that
 * without the calendar having to pick one number for both.
 */
export function eventDuration(totalMinutes: number | null | undefined, fallbackMinutes: number): number {
  if (typeof totalMinutes !== "number" || !Number.isFinite(totalMinutes) || totalMinutes <= 0) return fallbackMinutes;
  return Math.min(MAX_DURATION_MINUTES, Math.max(MIN_DURATION_MINUTES, Math.round(totalMinutes)));
}

/**
 * Serialize one week to an `.ics` document.
 *
 * Days are emitted in the order they appear in `week.days`, and slots within a
 * day in `MEAL_SLOTS` order, so the output is deterministic for a given input —
 * which is what makes byte-level assertions in the tests meaningful.
 */
export function buildWeekIcs(week: IcsWeek, options: BuildWeekIcsOptions = {}): string {
  const { siteUrl = "", now = new Date(), slotLabels = SLOT_LABELS, slotTimes = SLOT_TIMES, durationMinutes = SLOT_DURATION_MINUTES } = options;
  const dtstamp = stampFrom(now);

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    textProperty("X-WR-CALNAME", `Buttery meal plan ${week.weekStart} to ${week.weekEnd}`),
  ];

  for (const day of week.days) {
    for (const slot of MEAL_SLOTS) {
      const entries = day.slots[slot] ?? [];
      const recipes = entries.filter((e): e is Extract<IcsEntry, { kind: "recipe" }> => e.kind === "recipe");
      // Blank note bodies contribute nothing and must not create an event.
      const notes = entries.flatMap((e) => (e.kind === "note" && e.body.trim() ? [e] : []));
      if (!recipes.length && !notes.length) continue;

      const noteBodies = notes.map((n) => n.body.trim());
      const dtstart = utcStamp(day.date, slotTimes[slot], week.timezone);

      const event = (uid: string, summary: string, minutes: number, description: string[]) => {
        lines.push("BEGIN:VEVENT");
        lines.push(textProperty("UID", uid));
        lines.push(`DTSTAMP:${dtstamp}`);
        lines.push(`DTSTART:${dtstart}`);
        lines.push(`DTEND:${utcStamp(day.date, slotTimes[slot], week.timezone, minutes)}`);
        lines.push(textProperty("SUMMARY", summary));
        if (description.length) lines.push(textProperty("DESCRIPTION", description.join("\n")));
        lines.push("END:VEVENT");
      };

      if (recipes.length) {
        for (const entry of recipes) {
          // Buttery first and explicitly labelled, so a description holding two
          // links says which is which at a glance. The original source follows
          // when there is one — Buttery is not jealous about only ever linking
          // to itself, and the site a recipe was scraped from is often where
          // the comments, the video and the corrections live.
          const description: string[] = [];
          if (siteUrl) description.push(`Buttery: ${recipeUrl(siteUrl, entry.recipeId)}`);
          const source = httpUrl(entry.source?.url);
          if (source) description.push(`Source: ${source}`);
          description.push(...noteBodies);
          event(entryUid(entry.id), `${slotLabels[slot]}: ${entry.title}`, eventDuration(entry.totalMinutes, durationMinutes), description);
        }
        continue;
      }

      // Note-only slot: one event titled by the slot, keyed off the first
      // note's id so it stays stable across re-exports. A note has no total
      // time, so this one always runs the slot's default length.
      event(entryUid(notes[0].id), slotLabels[slot], durationMinutes, noteBodies);
    }
  }

  lines.push("END:VCALENDAR");
  // Trailing CRLF: every content line, including the last, is terminated.
  return `${lines.join(CRLF)}${CRLF}`;
}
