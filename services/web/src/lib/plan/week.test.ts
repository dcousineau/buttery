import { afterEach, describe, expect, it, vi } from "vitest";
import { MEAL_SLOTS, daysBetween, isMealSlot, isPlanDate, normalizeWeekStartDay, parseWeekParam, shiftDays, shiftWeeks, todayIn, weekDates, weekStartFor } from "./week";

// 2026-08-06 is a Thursday — the reference date the meal-planner plan and the
// design comps are both written against.

describe("MEAL_SLOTS", () => {
  it("is the canonical grid order", () => {
    expect(MEAL_SLOTS).toEqual(["breakfast", "lunch", "dinner", "snack"]);
  });

  it("guards unknown slot values", () => {
    expect(isMealSlot("dinner")).toBe(true);
    expect(isMealSlot("brunch")).toBe(false);
    expect(isMealSlot(undefined)).toBe(false);
  });
});

describe("isPlanDate", () => {
  it("accepts real ISO calendar dates", () => {
    expect(isPlanDate("2026-08-06")).toBe(true);
    expect(isPlanDate("2024-02-29")).toBe(true); // leap year
  });

  it("rejects dates that do not exist", () => {
    // The shape is right but the day is not: dayjs would roll this to Mar 3rd.
    expect(isPlanDate("2026-02-31")).toBe(false);
    expect(isPlanDate("2025-02-29")).toBe(false); // not a leap year
    expect(isPlanDate("2026-13-01")).toBe(false);
  });

  it("rejects anything that is not a YYYY-MM-DD string", () => {
    expect(isPlanDate("2026-8-6")).toBe(false);
    expect(isPlanDate("2026-08-06T00:00:00Z")).toBe(false);
    expect(isPlanDate("")).toBe(false);
    expect(isPlanDate(undefined)).toBe(false);
    expect(isPlanDate(20260806)).toBe(false);
  });
});

describe("weekStartFor", () => {
  it("snaps back to Monday when weekStartDay = 1", () => {
    // Thu 2026-08-06 → Mon 2026-08-03
    expect(weekStartFor("2026-08-06", 1)).toBe("2026-08-03");
  });

  it("snaps back to Sunday when weekStartDay = 7", () => {
    // Thu 2026-08-06 → Sun 2026-08-02
    expect(weekStartFor("2026-08-06", 7)).toBe("2026-08-02");
  });

  it("is a no-op on a date that is already the week start", () => {
    expect(weekStartFor("2026-08-03", 1)).toBe("2026-08-03");
    expect(weekStartFor("2026-08-02", 7)).toBe("2026-08-02");
  });

  it("snaps every day of one Monday-week to the same start", () => {
    const starts = weekDates("2026-08-03").map((d) => weekStartFor(d, 1));
    expect(new Set(starts)).toEqual(new Set(["2026-08-03"]));
  });

  it("handles every weekStartDay without ever moving forward", () => {
    for (let day = 1; day <= 7; day++) {
      const start = weekStartFor("2026-08-06", day);
      expect(start <= "2026-08-06").toBe(true);
      expect(daysBetween(start, "2026-08-06")).toBeLessThan(7);
      expect(weekStartFor(start, day)).toBe(start);
    }
  });

  it("crosses month and year boundaries", () => {
    expect(weekStartFor("2026-01-01", 1)).toBe("2025-12-29"); // Thu → prev Mon
    expect(weekStartFor("2026-03-01", 1)).toBe("2026-02-23");
  });

  it("falls back to Monday on an out-of-range weekStartDay", () => {
    expect(weekStartFor("2026-08-06", 0)).toBe("2026-08-03");
    expect(weekStartFor("2026-08-06", 99)).toBe("2026-08-03");
    expect(weekStartFor("2026-08-06", 1.5)).toBe("2026-08-03");
  });

  it("throws on a malformed date rather than guessing", () => {
    expect(() => weekStartFor("not-a-date", 1)).toThrow();
  });
});

describe("normalizeWeekStartDay", () => {
  it("passes 1…7 through and clamps everything else to Monday", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(normalizeWeekStartDay)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(normalizeWeekStartDay(0)).toBe(1);
    expect(normalizeWeekStartDay(8)).toBe(1);
    expect(normalizeWeekStartDay(Number.NaN)).toBe(1);
  });
});

describe("weekDates", () => {
  it("returns 7 consecutive dates starting at the week start", () => {
    expect(weekDates("2026-08-03")).toEqual(["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09"]);
  });

  it("crosses a month boundary", () => {
    expect(weekDates("2026-08-31")).toEqual(["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"]);
  });

  it("crosses a DST transition without dropping or repeating a date", () => {
    // US DST ends 2026-11-01. Pure calendar math must not care.
    expect(weekDates("2026-10-26")).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
  });
});

describe("shiftWeeks / shiftDays / daysBetween", () => {
  it("moves whole weeks in both directions", () => {
    expect(shiftWeeks("2026-08-03", 1)).toBe("2026-08-10");
    expect(shiftWeeks("2026-08-03", -1)).toBe("2026-07-27");
    expect(shiftWeeks("2026-08-03", 0)).toBe("2026-08-03");
  });

  it("round-trips across a year boundary", () => {
    expect(shiftWeeks(shiftWeeks("2025-12-29", 5), -5)).toBe("2025-12-29");
  });

  it("shifts single days and measures the gap between two dates", () => {
    expect(shiftDays("2026-08-06", 3)).toBe("2026-08-09");
    expect(shiftDays("2026-08-01", -1)).toBe("2026-07-31");
    expect(daysBetween("2026-08-03", "2026-08-06")).toBe(3);
    expect(daysBetween("2026-08-06", "2026-08-03")).toBe(-3);
    expect(daysBetween("2026-08-03", "2026-08-03")).toBe(0);
  });

  it("measures a DST-spanning gap in whole days", () => {
    expect(daysBetween("2026-10-31", "2026-11-02")).toBe(2);
  });
});

describe("todayIn", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns different calendar dates either side of the dateline", () => {
    // 2026-08-06T02:00Z: still Aug 5th in Los Angeles, already Aug 6th in Tokyo.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T02:00:00Z"));
    expect(todayIn("UTC")).toBe("2026-08-06");
    expect(todayIn("America/Los_Angeles")).toBe("2026-08-05");
    expect(todayIn("Asia/Tokyo")).toBe("2026-08-06");
  });

  it("falls back to UTC on an unknown zone instead of throwing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T02:00:00Z"));
    expect(todayIn("Mars/Olympus_Mons")).toBe("2026-08-06");
  });
});

describe("parseWeekParam", () => {
  it("accepts a valid date and does NOT snap it (the server owns snapping)", () => {
    expect(parseWeekParam("2026-08-06")).toBe("2026-08-06");
  });

  it("returns null for anything malformed", () => {
    expect(parseWeekParam(undefined)).toBeNull();
    expect(parseWeekParam("")).toBeNull();
    expect(parseWeekParam("next-week")).toBeNull();
    expect(parseWeekParam("2026-02-31")).toBeNull();
  });
});
