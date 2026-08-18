import { describe, expect, it } from "vitest";
import type { PlanDay, PlanEntry, PlanWeek } from "#/lib/api";
import { MEAL_SLOTS, type MealSlot, type PlanDate } from "#/lib/plan/week";
import { findEntry, isOptimisticId, optimisticNoteEntry, withEntriesAppended, withEntryCooked, withEntryMoved, withEntryRemoved, withNoteBody } from "./optimistic";

// The week of Thu 2026-08-06, the reference date the plan is written against.
const DATES: PlanDate[] = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09"];

function recipe(id: string, position: number, cooked = false): PlanEntry {
  return {
    id,
    kind: "recipe",
    position,
    recipeId: `r-${id}`,
    title: id,
    imageUrl: null,
    totalMinutes: 45,
    totalTimeDisplay: "45m",
    source: { kind: "note", label: "Buttery", url: null },
    inBox: true,
    unavailable: false,
    unpublished: false,
    cookedAt: cooked ? "2026-08-06T18:00:00.000Z" : null,
    cookedByHandle: cooked ? "@sam" : null,
    addedByHandle: "@sam",
  };
}

function note(id: string, position: number, body = "thaw the chicken"): PlanEntry {
  return { id, kind: "note", position, body, cookedAt: null, addedByHandle: "@sam" };
}

/** A week with everything empty except the slots named in `seed`. */
function makeWeek(seed: Partial<Record<`${PlanDate}|${MealSlot}`, PlanEntry[]>> = {}): PlanWeek {
  const days: PlanDay[] = DATES.map((date) => ({
    date,
    isToday: date === "2026-08-06",
    isPast: date < "2026-08-06",
    slots: Object.fromEntries(MEAL_SLOTS.map((slot) => [slot, seed[`${date}|${slot}`] ?? []])) as PlanDay["slots"],
  }));
  const entries = days.flatMap((day) => MEAL_SLOTS.flatMap((slot) => day.slots[slot]));
  return {
    weekStart: DATES[0],
    weekEnd: DATES[6],
    timezone: "America/Chicago",
    weekStartDay: 1,
    today: "2026-08-06",
    days,
    recipeEntryCount: entries.filter((entry) => entry.kind === "recipe").length,
    emptySlotCount: days.reduce((total, day) => total + MEAL_SLOTS.filter((slot) => day.slots[slot].length === 0).length, 0),
    cookedCount: entries.filter((entry) => entry.cookedAt !== null).length,
  };
}

function slotOf(week: PlanWeek, date: PlanDate, slot: MealSlot): PlanEntry[] {
  return week.days.find((day) => day.date === date)!.slots[slot];
}

describe("findEntry", () => {
  it("reports where an entry sits", () => {
    const week = makeWeek({ "2026-08-05|dinner": [recipe("a", 0)] });
    expect(findEntry(week, "a")).toMatchObject({ date: "2026-08-05", slot: "dinner" });
  });

  it("is null for an id the week does not contain", () => {
    expect(findEntry(makeWeek(), "nope")).toBeNull();
  });
});

describe("withEntryRemoved", () => {
  it("drops the entry and closes the gap in position", () => {
    const week = makeWeek({ "2026-08-05|dinner": [recipe("a", 0), recipe("b", 1), recipe("c", 2)] });
    const next = withEntryRemoved(week, "b");
    expect(slotOf(next, "2026-08-05", "dinner").map((entry) => [entry.id, entry.position])).toEqual([
      ["a", 0],
      ["c", 1],
    ]);
  });

  it("recounts the panel stats", () => {
    const week = makeWeek({ "2026-08-05|dinner": [recipe("a", 0, true)] });
    expect(week).toMatchObject({ recipeEntryCount: 1, cookedCount: 1, emptySlotCount: 27 });
    expect(withEntryRemoved(week, "a")).toMatchObject({ recipeEntryCount: 0, cookedCount: 0, emptySlotCount: 28 });
  });

  it("leaves the loader's payload untouched", () => {
    const week = makeWeek({ "2026-08-05|dinner": [recipe("a", 0), recipe("b", 1)] });
    withEntryRemoved(week, "a");
    expect(slotOf(week, "2026-08-05", "dinner").map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("ignores an unknown id", () => {
    const week = makeWeek({ "2026-08-05|dinner": [recipe("a", 0)] });
    expect(slotOf(withEntryRemoved(week, "ghost"), "2026-08-05", "dinner")).toHaveLength(1);
  });
});

describe("withEntryMoved", () => {
  it("appends to the destination tail and renumbers both slots", () => {
    const week = makeWeek({
      "2026-08-05|dinner": [recipe("a", 0), recipe("b", 1)],
      "2026-08-07|lunch": [recipe("c", 0)],
    });
    const next = withEntryMoved(week, "a", "2026-08-07", "lunch");
    expect(slotOf(next, "2026-08-05", "dinner").map((entry) => [entry.id, entry.position])).toEqual([["b", 0]]);
    expect(slotOf(next, "2026-08-07", "lunch").map((entry) => [entry.id, entry.position])).toEqual([
      ["c", 0],
      ["a", 1],
    ]);
  });

  it("is a no-op onto the slot the entry is already in", () => {
    const week = makeWeek({ "2026-08-05|dinner": [recipe("a", 0), recipe("b", 1)] });
    expect(withEntryMoved(week, "a", "2026-08-05", "dinner")).toBe(week);
  });

  it("is a no-op for an id the week does not contain", () => {
    const week = makeWeek();
    expect(withEntryMoved(week, "ghost", "2026-08-05", "dinner")).toBe(week);
  });

  it("moves within a day across slots", () => {
    const week = makeWeek({ "2026-08-05|dinner": [recipe("a", 0)] });
    const next = withEntryMoved(week, "a", "2026-08-05", "breakfast");
    expect(slotOf(next, "2026-08-05", "dinner")).toEqual([]);
    expect(slotOf(next, "2026-08-05", "breakfast").map((entry) => entry.id)).toEqual(["a"]);
    expect(next.emptySlotCount).toBe(27);
  });
});

describe("withEntryCooked", () => {
  it("sets and clears the mark, and keeps cookedCount honest", () => {
    const week = makeWeek({ "2026-08-05|dinner": [recipe("a", 0)] });
    const cooked = withEntryCooked(week, "a", true, "@sam");
    const entry = slotOf(cooked, "2026-08-05", "dinner")[0];
    expect(entry.cookedAt).not.toBeNull();
    expect(entry.kind === "recipe" && entry.cookedByHandle).toBe("@sam");
    expect(cooked.cookedCount).toBe(1);

    const cleared = withEntryCooked(cooked, "a", false);
    expect(slotOf(cleared, "2026-08-05", "dinner")[0].cookedAt).toBeNull();
    expect(cleared.cookedCount).toBe(0);
  });

  it("refuses to mark a note cooked", () => {
    const week = makeWeek({ "2026-08-05|dinner": [note("n", 0)] });
    expect(slotOf(withEntryCooked(week, "n", true), "2026-08-05", "dinner")[0].cookedAt).toBeNull();
  });
});

describe("withNoteBody", () => {
  it("replaces the text", () => {
    const week = makeWeek({ "2026-08-05|dinner": [note("n", 0)] });
    const next = slotOf(withNoteBody(week, "n", "  Sam cooks tonight  "), "2026-08-05", "dinner")[0];
    expect(next.kind === "note" && next.body).toBe("Sam cooks tonight");
  });

  it("treats an emptied body as a removal (§6.3)", () => {
    const week = makeWeek({ "2026-08-05|dinner": [note("n", 0), recipe("a", 1)] });
    const next = withNoteBody(week, "n", "   ");
    expect(slotOf(next, "2026-08-05", "dinner").map((entry) => [entry.id, entry.position])).toEqual([["a", 0]]);
  });
});

describe("withEntriesAppended", () => {
  it("adds to the tail with dense positions", () => {
    const week = makeWeek({ "2026-08-05|dinner": [recipe("a", 0)] });
    const next = withEntriesAppended(week, "2026-08-05", "dinner", [recipe("b", 99), note("n", 99)]);
    expect(slotOf(next, "2026-08-05", "dinner").map((entry) => [entry.id, entry.position])).toEqual([
      ["a", 0],
      ["b", 1],
      ["n", 2],
    ]);
    expect(next.recipeEntryCount).toBe(2);
  });

  it("ignores a date outside the visible week", () => {
    const week = makeWeek();
    expect(withEntriesAppended(week, "2026-09-01", "dinner", [recipe("b", 0)])).toBe(week);
  });
});

describe("optimistic ids", () => {
  it("are recognisable and cannot collide with a ULID", () => {
    expect(isOptimisticId(optimisticNoteEntry("hi", 0).id)).toBe(true);
    expect(isOptimisticId("01K1ZQ9F3B7WQ2N8V6XJ4M0T5R")).toBe(false);
  });
});
