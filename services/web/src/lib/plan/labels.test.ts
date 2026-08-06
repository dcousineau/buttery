import { describe, expect, it } from "vitest";
import { SLOT_LABELS, addToSlotLabel, formatPlanDate, longDow, shortDow, slotDayLine, weekRangeLabel, weekdayName } from "./labels";

// 2026-08-03 is a Monday; 2026-08-06 the Thursday the comps are drawn against.

describe("formatPlanDate", () => {
  it("prints the design's short form", () => {
    expect(formatPlanDate("2026-08-03")).toBe("Aug 3");
    expect(formatPlanDate("2026-12-25")).toBe("Dec 25");
    expect(formatPlanDate("2026-01-01")).toBe("Jan 1");
  });

  it("echoes malformed input instead of throwing", () => {
    expect(formatPlanDate("nope")).toBe("nope");
  });
});

describe("weekday names", () => {
  it("is Monday-indexed regardless of the week start", () => {
    expect(shortDow("2026-08-03")).toBe("Mon");
    expect(shortDow("2026-08-09")).toBe("Sun");
    expect(longDow("2026-08-06")).toBe("Thursday");
    // A Sunday-start household still labels each date by its real weekday.
    expect(longDow("2026-08-02")).toBe("Sunday");
  });
});

describe("composed labels", () => {
  it("builds the toolbar range, popover header, and add-button name", () => {
    expect(weekRangeLabel("2026-08-03", "2026-08-09")).toBe("Aug 3 – Aug 9");
    expect(slotDayLine("dinner", "2026-08-05")).toBe("Dinner · Wed, Aug 5");
    expect(addToSlotLabel("dinner", "2026-08-05")).toBe("Add to dinner on Aug 5");
  });

  it("labels every slot", () => {
    expect(SLOT_LABELS).toEqual({ breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" });
  });

  it("names ISO weekdays for the week-start preference", () => {
    expect(weekdayName(1)).toBe("Monday");
    expect(weekdayName(7)).toBe("Sunday");
    // Out of range can only come from a corrupted preference row; it falls back
    // to the default week start rather than rendering "undefined start".
    expect(weekdayName(0)).toBe("Monday");
    expect(weekdayName(9)).toBe("Monday");
  });
});
