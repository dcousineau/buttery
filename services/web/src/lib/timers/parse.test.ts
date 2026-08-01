import { describe, expect, it } from "vitest";
import { hasTime, labelFor, parseStep, type TimeToken } from "./parse";

/**
 * Step-time parser (plan §10). Covers each accepted duration form (single,
 * decimal, every range dash, every unit), the range upper-bound rule, verb
 * stemming hits/misses, the noun fallback, no-time pass-through, and multiple
 * durations in one step.
 */

/** Pull just the time tokens out of a parse. */
function times(text: string): TimeToken[] {
  return parseStep(text).filter((t): t is TimeToken => t.isTime);
}

describe("parseStep — duration forms", () => {
  it("parses a single integer + unit", () => {
    const [t] = times("Bake for 25 minutes.");
    expect(t.seconds).toBe(1500);
    expect(t.text).toBe("25 minutes");
  });

  it("parses a decimal quantity", () => {
    expect(times("Roast 1.5 hours.")[0].seconds).toBe(5400);
  });

  it("maps every unit family to seconds", () => {
    expect(times("Rest 2 hours")[0].seconds).toBe(7200);
    expect(times("Rest 2 hrs")[0].seconds).toBe(7200);
    expect(times("Simmer 10 min")[0].seconds).toBe(600);
    expect(times("Simmer 10 mins")[0].seconds).toBe(600);
    expect(times("Blanch 30 seconds")[0].seconds).toBe(30);
    expect(times("Blanch 45 secs")[0].seconds).toBe(45);
    expect(times("Blanch 15 sec")[0].seconds).toBe(15);
  });

  it("uses the upper bound for every range dash form", () => {
    for (const dash of ["to", "-", "–", "—"]) {
      const [t] = times(`Simmer 5 ${dash} 7 minutes.`);
      expect(t.seconds, dash).toBe(420); // 7 * 60, not 5
    }
  });

  it("uses the upper bound for a decimal range", () => {
    expect(times("Bake 1 to 1.5 hours")[0].seconds).toBe(5400);
  });

  it("finds multiple durations in one step", () => {
    const ts = times("Whisk 2 minutes, then rest 30 minutes.");
    expect(ts.map((t) => t.seconds)).toEqual([120, 1800]);
    expect(ts.map((t) => t.label)).toEqual(["Whisk", "Rest"]);
  });

  it("passes a no-time step through as a single text token", () => {
    const tokens = parseStep("Season with salt and pepper to taste.");
    expect(tokens).toEqual([{ isTime: false, text: "Season with salt and pepper to taste." }]);
  });

  it("preserves surrounding text as text tokens", () => {
    const tokens = parseStep("Bake 25 minutes until golden.");
    expect(tokens[0]).toEqual({ isTime: false, text: "Bake " });
    expect(tokens[1].isTime).toBe(true);
    expect(tokens[2]).toEqual({ isTime: false, text: " until golden." });
  });

  it("ignores a bare number with no unit (temperature-safe)", () => {
    expect(times("Preheat the oven to 350 and bake.")).toHaveLength(0);
  });
});

describe("labelFor — verb stemming + fallbacks", () => {
  it("matches base verbs", () => {
    expect(labelFor("Bake at 350")).toBe("Bake");
    expect(labelFor("Rest the dough")).toBe("Rest");
  });

  it("stems inflected verbs (-ing/-ed/-e restore)", () => {
    expect(labelFor("Baking the loaf")).toBe("Bake");
    expect(labelFor("Simmering the sauce")).toBe("Simmer");
    expect(labelFor("Marinated overnight")).toBe("Marinate");
    expect(labelFor("Reduced the stock")).toBe("Reduce");
  });

  it("stems -s / -es forms", () => {
    expect(labelFor("She bakes the bread")).toBe("Bake");
    expect(labelFor("It braises slowly")).toBe("Braise");
  });

  it("takes the nearest verb (the clause the duration belongs to) when several appear", () => {
    expect(labelFor("Preheat then bake")).toBe("Bake");
    expect(labelFor("Whisk 2 minutes, then rest")).toBe("Rest");
  });

  it("keeps accented verbs intact", () => {
    expect(labelFor("Sauté the onions")).toBe("Sauté");
  });

  it("falls back to a noun when no verb governs the time", () => {
    expect(labelFor("Into a hot skillet")).toBe("Skillet");
    expect(labelFor("In the oven")).toBe("Oven");
  });

  it("returns Timer when nothing matches", () => {
    expect(labelFor("Then wait for about")).toBe("Timer");
    expect(labelFor("")).toBe("Timer");
  });

  it("only considers the ~14 words before the time", () => {
    const far = "bake " + "and ".repeat(20) + "leave it";
    expect(labelFor(far)).toBe("Timer"); // the verb is now >14 words back
  });
});

describe("hasTime", () => {
  it("detects a duration", () => {
    expect(hasTime("Bake 25 minutes")).toBe(true);
  });
  it("is false with no duration", () => {
    expect(hasTime("Chop the onion finely")).toBe(false);
  });
});
