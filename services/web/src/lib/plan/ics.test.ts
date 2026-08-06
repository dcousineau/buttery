import { describe, expect, it } from "vitest";
import {
  type IcsEntry,
  type IcsWeek,
  MAX_DURATION_MINUTES,
  MIN_DURATION_MINUTES,
  PRODID,
  SLOT_LABELS,
  SLOT_TIMES,
  buildWeekIcs,
  entryUid,
  escapeText,
  eventDuration,
  foldLine,
  httpUrl,
  icsFilename,
  utcStamp,
} from "./ics";
import { SLOT_LABELS as UI_SLOT_LABELS } from "./labels";
import { type MealSlot, weekDates } from "./week";

// 2026-08-03 (Monday) … 2026-08-09 — the Monday-start week containing the
// reference Thursday the plan and comps are written against.
const WEEK_START = "2026-08-03";
const WEEK_END = "2026-08-09";

/** Fixed generation instant so DTSTAMP is assertable byte for byte. */
const NOW = new Date("2026-08-01T09:15:00Z");

const emptySlots = (): Record<MealSlot, IcsEntry[]> => ({ breakfast: [], lunch: [], dinner: [], snack: [] });

/**
 * Build a week skeleton and drop `entries` into `date`/`slot`. Mirrors the
 * shape `getMealPlanWeek` returns (all 7 days, all 4 slots, always present).
 */
function week(placements: Array<{ date: string; slot: MealSlot; entries: IcsEntry[] }> = [], timezone = "America/Chicago"): IcsWeek {
  const days = weekDates(WEEK_START).map((date) => ({ date, slots: emptySlots() }));
  for (const { date, slot, entries } of placements) {
    const day = days.find((d) => d.date === date);
    if (!day) throw new Error(`test fixture placed an entry outside the week: ${date}`);
    day.slots[slot].push(...entries);
  }
  return { weekStart: WEEK_START, weekEnd: WEEK_END, timezone, days };
}

const recipe = (id: string, title: string, recipeId = `r-${id}`, extra: { totalMinutes?: number | null; source?: { url: string | null } | null } = {}): IcsEntry => ({
  id,
  kind: "recipe",
  recipeId,
  title,
  ...extra,
});
const note = (id: string, body: string): IcsEntry => ({ id, kind: "note", body });

/** Unfold a serialized calendar back into logical content lines (RFC 5545 §3.1). */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, "").split("\r\n");
}

describe("escapeText", () => {
  it("escapes backslash, semicolon and comma", () => {
    expect(escapeText("a,b;c\\d")).toBe("a\\,b\\;c\\\\d");
  });

  it("escapes the backslash first so its own escapes survive", () => {
    // A literal `\,` must become `\\\,`, not `\\,` — order matters.
    expect(escapeText("\\,")).toBe("\\\\\\,");
  });

  it("turns every flavour of newline into a literal \\n", () => {
    expect(escapeText("one\ntwo\r\nthree\rfour")).toBe("one\\ntwo\\nthree\\nfour");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeText("Chicken Tikka Masala")).toBe("Chicken Tikka Masala");
  });
});

describe("foldLine", () => {
  it("leaves a line of 75 octets or fewer untouched", () => {
    const line = "X".repeat(75);
    expect(foldLine(line)).toBe(line);
  });

  it("folds a long line at 75 octets, continuations at 74 + a leading space", () => {
    const folded = foldLine("X".repeat(200));
    const segments = folded.split("\r\n");
    expect(segments[0]).toHaveLength(75);
    for (const seg of segments.slice(1)) {
      expect(seg.startsWith(" ")).toBe(true);
      expect(seg.length).toBeLessThanOrEqual(75);
    }
    // Unfolding restores the original exactly.
    expect(folded.replace(/\r\n /g, "")).toBe("X".repeat(200));
  });

  it("counts octets, not characters, and never splits a multi-byte character", () => {
    // "é" is 2 octets in UTF-8, so 40 of them is 80 octets — over the limit.
    const folded = foldLine("é".repeat(40));
    const [first] = folded.split("\r\n");
    expect(new TextEncoder().encode(first).length).toBeLessThanOrEqual(75);
    expect(folded).not.toContain("�");
    expect(folded.replace(/\r\n /g, "")).toBe("é".repeat(40));
  });

  it("keeps an astral character (surrogate pair) whole", () => {
    // 4 octets each; 19 of them (76 octets) forces exactly one fold.
    const folded = foldLine("🥐".repeat(19));
    expect(folded.replace(/\r\n /g, "")).toBe("🥐".repeat(19));
    for (const seg of folded.split("\r\n")) {
      expect(new TextEncoder().encode(seg).length).toBeLessThanOrEqual(75);
    }
  });
});

describe("utcStamp", () => {
  it("converts a local slot time to a UTC Z stamp", () => {
    // 2026-08-03 is CDT (UTC-5): 18:30 local → 23:30Z.
    expect(utcStamp("2026-08-03", SLOT_TIMES.dinner, "America/Chicago")).toBe("20260803T233000Z");
  });

  it("adds the event duration in minutes, rolling the day when it must", () => {
    expect(utcStamp("2026-08-03", "18:30", "America/Chicago", 30)).toBe("20260804T000000Z");
  });

  it("tracks the DST offset change either side of a transition", () => {
    // US DST ends 2026-11-01. Oct 30 is CDT (UTC-5), Nov 2 is CST (UTC-6) —
    // the same wall-clock 18:30 lands on two different UTC hours.
    expect(utcStamp("2026-10-30", "18:30", "America/Chicago")).toBe("20261030T233000Z");
    expect(utcStamp("2026-11-02", "18:30", "America/Chicago")).toBe("20261103T003000Z");
  });

  it("is a pass-through for UTC households", () => {
    expect(utcStamp("2026-08-03", "08:00", "UTC")).toBe("20260803T080000Z");
  });

  it("falls back to UTC on an unknown zone instead of throwing", () => {
    expect(utcStamp("2026-08-03", "08:00", "Mars/Olympus_Mons")).toBe("20260803T080000Z");
  });
});

describe("entryUid / icsFilename", () => {
  it("namespaces the entry id so re-import updates rather than duplicates", () => {
    expect(entryUid("entry-1")).toBe("entry-1@buttery.app");
    expect(entryUid("entry-1")).toBe(entryUid("entry-1"));
  });

  it("names the download after the week start", () => {
    expect(icsFilename(WEEK_START)).toBe("buttery-meal-plan-2026-08-03.ics");
  });
});

describe("buildWeekIcs — envelope", () => {
  it("emits a well-formed VCALENDAR wrapper", () => {
    const lines = unfold(buildWeekIcs(week(), { now: NOW }));
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("VERSION:2.0");
    expect(lines).toContain(`PRODID:${PRODID}`);
    expect(lines).toContain("CALSCALE:GREGORIAN");
    // Trailing "" is the split artefact of the file's final CRLF.
    expect(lines.at(-2)).toBe("END:VCALENDAR");
  });

  it("uses CRLF everywhere and terminates the last line", () => {
    const ics = buildWeekIcs(week([{ date: "2026-08-03", slot: "dinner", entries: [recipe("e1", "Soup")] }]), { now: NOW });
    expect(ics.endsWith("\r\n")).toBe(true);
    // No bare LF anywhere: every \n in the document is preceded by \r.
    expect(/[^\r]\n/.test(ics)).toBe(false);
  });

  it("ships no VTIMEZONE — every stamp is already UTC", () => {
    const ics = buildWeekIcs(week([{ date: "2026-08-03", slot: "dinner", entries: [recipe("e1", "Soup")] }]), { now: NOW });
    expect(ics).not.toContain("VTIMEZONE");
    expect(ics).not.toContain("TZID");
  });

  it("stamps every event with the injected DTSTAMP", () => {
    const ics = buildWeekIcs(week([{ date: "2026-08-03", slot: "dinner", entries: [recipe("e1", "Soup")] }]), { now: NOW });
    expect(unfold(ics)).toContain("DTSTAMP:20260801T091500Z");
  });

  it("produces a calendar with zero events for an empty week", () => {
    const ics = buildWeekIcs(week(), { now: NOW });
    expect(ics).not.toContain("BEGIN:VEVENT");
    expect(unfold(ics).filter(Boolean)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      `PRODID:${PRODID}`,
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:Buttery meal plan 2026-08-03 to 2026-08-09",
      "END:VCALENDAR",
    ]);
  });
});

describe("buildWeekIcs — recipe entries", () => {
  const oneDinner = week([{ date: "2026-08-06", slot: "dinner", entries: [recipe("e1", "Chicken Tikka Masala", "rec-123")] }]);

  it("writes one VEVENT per recipe entry with slot-prefixed summary and stable UID", () => {
    const lines = unfold(buildWeekIcs(oneDinner, { now: NOW, siteUrl: "https://buttery.app" }));
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines).toContain("UID:e1@buttery.app");
    expect(lines).toContain("SUMMARY:Dinner: Chicken Tikka Masala");
    // UPDATED: the Buttery link is now explicitly labelled.
    expect(lines).toContain("DESCRIPTION:Buttery: https://buttery.app/recipes/rec-123");
  });

  it("times the event from the slot table in the household timezone, the fallback 30 minutes long", () => {
    const lines = unfold(buildWeekIcs(oneDinner, { now: NOW }));
    expect(lines).toContain("DTSTART:20260806T233000Z");
    expect(lines).toContain("DTEND:20260807T000000Z");
  });

  it("gives every slot its own default time", () => {
    const lines = unfold(
      buildWeekIcs(
        week(
          [
            { date: "2026-08-03", slot: "breakfast", entries: [recipe("b", "Oats")] },
            { date: "2026-08-03", slot: "lunch", entries: [recipe("l", "Salad")] },
            { date: "2026-08-03", slot: "snack", entries: [recipe("s", "Apple")] },
            { date: "2026-08-03", slot: "dinner", entries: [recipe("d", "Stew")] },
          ],
          "UTC",
        ),
        { now: NOW },
      ),
    );
    expect(lines.filter((l) => l.startsWith("DTSTART:"))).toEqual(["DTSTART:20260803T080000Z", "DTSTART:20260803T123000Z", "DTSTART:20260803T183000Z", "DTSTART:20260803T150000Z"]);
  });

  it("emits events day by day, slots in canonical grid order", () => {
    const lines = unfold(
      buildWeekIcs(
        week([
          { date: "2026-08-04", slot: "dinner", entries: [recipe("d2", "Tuesday dinner")] },
          { date: "2026-08-03", slot: "dinner", entries: [recipe("d1", "Monday dinner")] },
          { date: "2026-08-03", slot: "breakfast", entries: [recipe("b1", "Monday breakfast")] },
        ]),
        { now: NOW },
      ),
    );
    expect(lines.filter((l) => l.startsWith("UID:"))).toEqual(["UID:b1@buttery.app", "UID:d1@buttery.app", "UID:d2@buttery.app"]);
  });

  it("keeps two entries in one slot as two events (duplicates are legal, D4)", () => {
    const lines = unfold(buildWeekIcs(week([{ date: "2026-08-03", slot: "dinner", entries: [recipe("e1", "Soup"), recipe("e2", "Soup")] }]), { now: NOW }));
    expect(lines.filter((l) => l.startsWith("UID:"))).toEqual(["UID:e1@buttery.app", "UID:e2@buttery.app"]);
  });

  it("is byte-stable across rebuilds of the same input", () => {
    expect(buildWeekIcs(oneDinner, { now: NOW })).toBe(buildWeekIcs(oneDinner, { now: NOW }));
  });

  it("omits DESCRIPTION entirely when there is no site URL and no note", () => {
    expect(buildWeekIcs(oneDinner, { now: NOW })).not.toContain("DESCRIPTION");
  });
});

describe("buildWeekIcs — notes", () => {
  it("folds a slot's notes into each recipe event's DESCRIPTION", () => {
    const ics = buildWeekIcs(week([{ date: "2026-08-03", slot: "dinner", entries: [recipe("e1", "Soup", "rec-1"), note("n1", "Double the batch"), note("n2", "Sam is out")] }]), {
      now: NOW,
      siteUrl: "https://buttery.app",
    });
    const lines = unfold(ics);
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    // UPDATED: the Buttery link is labelled and still leads the description.
    expect(lines).toContain("DESCRIPTION:Buttery: https://buttery.app/recipes/rec-1\\nDouble the batch\\nSam is out");
  });

  it("gives a note-only slot one event titled by the slot, keyed off the first note", () => {
    const lines = unfold(buildWeekIcs(week([{ date: "2026-08-05", slot: "lunch", entries: [note("n1", "Leftovers"), note("n2", "Use the sourdough")] }]), { now: NOW }));
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines).toContain("UID:n1@buttery.app");
    expect(lines).toContain("SUMMARY:Lunch");
    expect(lines).toContain("DESCRIPTION:Leftovers\\nUse the sourdough");
  });

  it("ignores a blank note rather than emitting an empty event", () => {
    const ics = buildWeekIcs(week([{ date: "2026-08-05", slot: "lunch", entries: [note("n1", "   ")] }]), { now: NOW });
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("escapes note punctuation and newlines inside DESCRIPTION", () => {
    const lines = unfold(buildWeekIcs(week([{ date: "2026-08-03", slot: "dinner", entries: [note("n1", "Buy: rice, peas; also\nice")] }]), { now: NOW }));
    expect(lines).toContain("DESCRIPTION:Buy: rice\\, peas\\; also\\nice");
  });
});

describe("buildWeekIcs — escaping and folding in context", () => {
  it("escapes a recipe title's commas and semicolons in SUMMARY", () => {
    const lines = unfold(buildWeekIcs(week([{ date: "2026-08-03", slot: "dinner", entries: [recipe("e1", "Beans, rice; hot sauce")] }]), { now: NOW }));
    expect(lines).toContain("SUMMARY:Dinner: Beans\\, rice\\; hot sauce");
  });

  it("folds a long SUMMARY and unfolds back to the escaped original", () => {
    const title = "Slow-braised short ribs with gremolata, polenta, and a very long trailing description";
    const ics = buildWeekIcs(week([{ date: "2026-08-03", slot: "dinner", entries: [recipe("e1", title)] }]), { now: NOW });
    // The raw document really is folded…
    expect(ics).toContain("\r\n ");
    for (const line of ics.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    // …and unfolding recovers the single logical line.
    expect(unfold(ics)).toContain(`SUMMARY:Dinner: ${title.replace(/,/g, "\\,")}`);
  });
});

describe("httpUrl", () => {
  it("accepts http and https", () => {
    expect(httpUrl("https://smittenkitchen.com/2019/03/one-pan-farro/")).toBe("https://smittenkitchen.com/2019/03/one-pan-farro/");
    expect(httpUrl("http://example.com/r")).toBe("http://example.com/r");
  });

  it("rejects a source that is only a label", () => {
    expect(httpUrl("Handwritten in your box")).toBeNull();
    expect(httpUrl("@sam.bsky.social")).toBeNull();
    expect(httpUrl("smittenkitchen.com")).toBeNull();
  });

  it("rejects a non-http scheme", () => {
    // Scraped/synced data is untrusted: a calendar client must never be handed
    // one of these as a clickable link.
    expect(httpUrl("javascript:alert(1)")).toBeNull();
    expect(httpUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(httpUrl("mailto:cook@example.com")).toBeNull();
    expect(httpUrl("file:///etc/passwd")).toBeNull();
    expect(httpUrl("webcal://example.com/feed.ics")).toBeNull();
  });

  it("rejects nothing-at-all without throwing", () => {
    expect(httpUrl(null)).toBeNull();
    expect(httpUrl(undefined)).toBeNull();
    expect(httpUrl("")).toBeNull();
    expect(httpUrl("   ")).toBeNull();
  });

  it("strips the newlines a URL could otherwise smuggle into a content line", () => {
    expect(httpUrl("https://example.com/a\r\nSUMMARY:pwned")).toBe("https://example.com/aSUMMARY:pwned");
  });
});

describe("eventDuration", () => {
  it("uses the recipe's total time when it has one", () => {
    expect(eventDuration(45, 30)).toBe(45);
    expect(eventDuration(90, 30)).toBe(90);
  });

  it("falls back when there is no usable time", () => {
    expect(eventDuration(null, 30)).toBe(30);
    expect(eventDuration(undefined, 30)).toBe(30);
    expect(eventDuration(0, 30)).toBe(30);
    expect(eventDuration(-10, 30)).toBe(30);
    expect(eventDuration(Number.NaN, 30)).toBe(30);
    expect(eventDuration(Number.POSITIVE_INFINITY, 30)).toBe(30);
  });

  it("clamps an absurd scraped time at both ends", () => {
    expect(eventDuration(2, 30)).toBe(MIN_DURATION_MINUTES);
    // A 3-day ferment would otherwise paint over the rest of the week.
    expect(eventDuration(3 * 24 * 60, 30)).toBe(MAX_DURATION_MINUTES);
  });

  it("rounds a fractional minute", () => {
    expect(eventDuration(45.4, 30)).toBe(45);
    expect(eventDuration(45.6, 30)).toBe(46);
  });
});

describe("buildWeekIcs — slot prefix in SUMMARY", () => {
  it("uses the very same slot labels the planner UI renders", () => {
    expect(SLOT_LABELS).toBe(UI_SLOT_LABELS);
  });

  it("prefixes every slot's event with that slot's label", () => {
    const lines = unfold(
      buildWeekIcs(
        week([
          { date: "2026-08-03", slot: "breakfast", entries: [recipe("b", "Oats")] },
          { date: "2026-08-03", slot: "lunch", entries: [recipe("l", "Salad")] },
          { date: "2026-08-03", slot: "snack", entries: [recipe("s", "Apple")] },
          { date: "2026-08-03", slot: "dinner", entries: [recipe("d", "Stew")] },
        ]),
        { now: NOW },
      ),
    );
    expect(lines.filter((l) => l.startsWith("SUMMARY:"))).toEqual(["SUMMARY:Breakfast: Oats", "SUMMARY:Lunch: Salad", "SUMMARY:Dinner: Stew", "SUMMARY:Snack: Apple"]);
  });

  it("prefixes each event separately when a slot holds several recipes", () => {
    // One VEVENT per recipe entry (§9.3), so the multi-entry slot reads as two
    // naturally-titled events rather than one joined-up summary.
    const lines = unfold(buildWeekIcs(week([{ date: "2026-08-03", slot: "dinner", entries: [recipe("e1", "Roast chicken"), recipe("e2", "Braised greens")] }]), { now: NOW }));
    expect(lines.filter((l) => l.startsWith("SUMMARY:"))).toEqual(["SUMMARY:Dinner: Roast chicken", "SUMMARY:Dinner: Braised greens"]);
  });

  it("titles a note-only slot with the bare slot label", () => {
    const lines = unfold(buildWeekIcs(week([{ date: "2026-08-03", slot: "lunch", entries: [note("n1", "Leftovers")] }]), { now: NOW }));
    expect(lines.filter((l) => l.startsWith("SUMMARY:"))).toEqual(["SUMMARY:Lunch"]);
  });
});

describe("buildWeekIcs — duration from the recipe's total time", () => {
  const at = (placements: Parameters<typeof week>[0]) => unfold(buildWeekIcs(week(placements, "UTC"), { now: NOW }));

  it("runs the event for the recipe's total time", () => {
    const lines = at([{ date: "2026-08-03", slot: "dinner", entries: [recipe("e1", "Short ribs", "r1", { totalMinutes: 90 })] }]);
    expect(lines).toContain("DTSTART:20260803T183000Z");
    expect(lines).toContain("DTEND:20260803T200000Z");
  });

  it("falls back to the per-slot default when the recipe carries no time", () => {
    const lines = at([{ date: "2026-08-03", slot: "dinner", entries: [recipe("e1", "Untimed", "r1", { totalMinutes: null })] }]);
    expect(lines).toContain("DTEND:20260803T190000Z");
  });

  it("falls back for a note-only slot — a note never has a time", () => {
    const lines = at([{ date: "2026-08-03", slot: "lunch", entries: [note("n1", "Leftovers")] }]);
    expect(lines).toContain("DTSTART:20260803T123000Z");
    expect(lines).toContain("DTEND:20260803T130000Z");
  });

  it("gives two recipes in one slot a shared start and their own separate lengths", () => {
    // The deliberate answer to "which time wins when a slot holds several?":
    // neither. Two dishes cooked side by side overlap, so they become two
    // concurrent events, not one event of the longest or the summed time.
    const lines = at([
      {
        date: "2026-08-03",
        slot: "dinner",
        entries: [recipe("e1", "Roast chicken", "r1", { totalMinutes: 90 }), recipe("e2", "Braised greens", "r2", { totalMinutes: 25 })],
      },
    ]);
    expect(lines.filter((l) => l.startsWith("DTSTART:"))).toEqual(["DTSTART:20260803T183000Z", "DTSTART:20260803T183000Z"]);
    expect(lines.filter((l) => l.startsWith("DTEND:"))).toEqual(["DTEND:20260803T200000Z", "DTEND:20260803T185500Z"]);
  });

  it("mixes a timed and an untimed recipe in one slot without either infecting the other", () => {
    const lines = at([
      {
        date: "2026-08-03",
        slot: "dinner",
        entries: [recipe("e1", "Timed", "r1", { totalMinutes: 120 }), recipe("e2", "Untimed", "r2")],
      },
    ]);
    expect(lines.filter((l) => l.startsWith("DTEND:"))).toEqual(["DTEND:20260803T203000Z", "DTEND:20260803T190000Z"]);
  });

  it("clamps a nonsensical total time rather than emitting a sliver or a multi-day block", () => {
    const lines = at([
      { date: "2026-08-03", slot: "breakfast", entries: [recipe("e1", "Instant", "r1", { totalMinutes: 1 })] },
      { date: "2026-08-04", slot: "breakfast", entries: [recipe("e2", "Sourdough", "r2", { totalMinutes: 4320 })] },
    ]);
    // 08:00 + 15m floor, and 08:00 + the 8h ceiling.
    expect(lines).toContain("DTEND:20260803T081500Z");
    expect(lines).toContain("DTEND:20260804T160000Z");
  });

  it("honours an explicit fallback duration for untimed entries only", () => {
    const lines = unfold(
      buildWeekIcs(week([{ date: "2026-08-03", slot: "dinner", entries: [recipe("e1", "Untimed"), recipe("e2", "Timed", "r2", { totalMinutes: 60 })] }], "UTC"), {
        now: NOW,
        durationMinutes: 20,
      }),
    );
    expect(lines.filter((l) => l.startsWith("DTEND:"))).toEqual(["DTEND:20260803T185000Z", "DTEND:20260803T193000Z"]);
  });
});

describe("buildWeekIcs — DESCRIPTION links", () => {
  const build = (entry: IcsEntry, siteUrl?: string) => unfold(buildWeekIcs(week([{ date: "2026-08-03", slot: "dinner", entries: [entry] }]), { now: NOW, siteUrl }));

  it("labels the Buttery link and puts it first", () => {
    const lines = build(recipe("e1", "Soup", "rec-1", { source: { url: "https://smittenkitchen.com/soup/" } }), "https://buttery.app");
    expect(lines).toContain("DESCRIPTION:Buttery: https://buttery.app/recipes/rec-1\\nSource: https://smittenkitchen.com/soup/");
  });

  it("emits an http(s) source alongside the Buttery link", () => {
    const lines = build(recipe("e1", "Soup", "rec-1", { source: { url: "http://example.com/soup" } }), "https://buttery.app");
    expect(lines).toContain("DESCRIPTION:Buttery: https://buttery.app/recipes/rec-1\\nSource: http://example.com/soup");
  });

  it("does NOT emit a source that is only a label", () => {
    const lines = build(recipe("e1", "Grandma's soup", "rec-1", { source: { url: null } }), "https://buttery.app");
    expect(lines).toContain("DESCRIPTION:Buttery: https://buttery.app/recipes/rec-1");
    expect(lines.join("\n")).not.toContain("Source:");
  });

  it("does NOT emit a non-http scheme as a link", () => {
    const lines = build(recipe("e1", "Soup", "rec-1", { source: { url: "javascript:alert(1)" } }), "https://buttery.app");
    expect(lines).toContain("DESCRIPTION:Buttery: https://buttery.app/recipes/rec-1");
    expect(lines.join("\n")).not.toContain("javascript:");
  });

  it("escapes a source URL's TEXT-significant characters", () => {
    // `,` and `;` are legal path sub-delimiters, so they survive URL parsing
    // and must be escaped by RFC 5545 §3.3.11 on the way out.
    const lines = build(recipe("e1", "Soup", "rec-1", { source: { url: "https://example.com/a,b;c" } }));
    expect(lines).toContain("DESCRIPTION:Source: https://example.com/a\\,b\\;c");
  });

  it("orders Buttery, then source, then the slot's notes", () => {
    const lines = unfold(
      buildWeekIcs(
        week([
          {
            date: "2026-08-03",
            slot: "dinner",
            entries: [recipe("e1", "Soup", "rec-1", { source: { url: "https://example.com/soup" } }), note("n1", "Double the batch")],
          },
        ]),
        { now: NOW, siteUrl: "https://buttery.app" },
      ),
    );
    expect(lines).toContain("DESCRIPTION:Buttery: https://buttery.app/recipes/rec-1\\nSource: https://example.com/soup\\nDouble the batch");
  });

  it("still omits DESCRIPTION entirely when there is no link and no note", () => {
    const lines = build(recipe("e1", "Soup", "rec-1", { source: { url: "Handwritten in your box" } }));
    expect(lines.join("\n")).not.toContain("DESCRIPTION");
  });
});
