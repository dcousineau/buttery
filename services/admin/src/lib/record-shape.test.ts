import { describe, expect, it } from "vitest";
import { compareProjections, flattenRecord, scalarPaths } from "./record-shape.ts";

describe("flattenRecord", () => {
  it("emits parents before children, in wire order", () => {
    const rows = flattenRecord({ b: 1, a: { z: "x" } });
    expect(rows.map((row) => row.path)).toEqual(["b", "a", "a.z"]);
  });

  it("keeps container rows so an empty field is distinguishable from a missing one", () => {
    const rows = flattenRecord({ embed: { images: [] } });
    const images = rows.find((row) => row.path === "embed.images");
    expect(images).toMatchObject({ type: "array", value: "[0]", container: true });
  });

  it("indexes array elements and reports integer vs number", () => {
    const rows = flattenRecord({ nums: [1, 1.5] });
    expect(rows.filter((row) => !row.container).map((row) => [row.path, row.type])).toEqual([
      ["nums.0", "integer"],
      ["nums.1", "number"],
    ]);
  });

  it("surfaces fields no lexicon declares — the reason the raw view exists", () => {
    expect(scalarPaths({ name: "x", weirdUndeclaredField: "y" })).toEqual({ name: "x", weirdUndeclaredField: "y" });
  });

  it("renders strings without quotes and null as null", () => {
    expect(scalarPaths({ a: "hi", b: null })).toEqual({ a: "hi", b: "null" });
  });
});

describe("compareProjections", () => {
  const find = (rows: ReturnType<typeof compareProjections>, path: string) => rows.find((row) => row.path === path);

  it("marks a field neither side sets as `absent`, not `network-only`", () => {
    const rows = compareProjections({ name: "a" }, { name: "a" });
    expect(find(rows, "recipeYield")?.status).toBe("absent");
  });

  it("distinguishes the two one-sided cases", () => {
    const rows = compareProjections({ name: "a", prepTime: "PT5M" }, { name: "a", cookTime: "PT9M" });
    expect(find(rows, "prepTime")?.status).toBe("local-only");
    expect(find(rows, "cookTime")?.status).toBe("network-only");
  });

  it("treats two spellings of the same instant as equal", () => {
    // Postgres re-prints a timestamptz with milliseconds; the record carries
    // whatever the publishing client wrote. Byte-comparing them reports every
    // published recipe as drifted.
    const rows = compareProjections({ createdAt: "2026-08-01T10:00:00.000Z" }, { createdAt: "2026-08-01T10:00:00Z" });
    expect(find(rows, "createdAt")?.status).toBe("same");
  });

  it("still flags a genuinely different instant", () => {
    const rows = compareProjections({ updatedAt: "2026-08-02T10:00:00.000Z" }, { updatedAt: "2026-08-01T10:00:00Z" });
    expect(find(rows, "updatedAt")?.status).toBe("differs");
  });

  it("falls back to a literal comparison when a timestamp does not parse", () => {
    const rows = compareProjections({ createdAt: "not a date" }, { createdAt: "2026-08-01T10:00:00Z" });
    expect(find(rows, "createdAt")?.status).toBe("differs");
  });

  it("does not date-coerce non-timestamp fields", () => {
    // "1" and "01" are the same number and the same Date; they are not the same
    // yield, and a general date test would call them equal.
    const rows = compareProjections({ recipeYield: "1" }, { recipeYield: "01" });
    expect(find(rows, "recipeYield")?.status).toBe("differs");
  });

  it("includes repeated paths from whichever side has them", () => {
    const rows = compareProjections({ "ingredients.0": "flour" }, { "ingredients.0": "flour", "ingredients.1": "milk" });
    expect(find(rows, "ingredients.0")?.status).toBe("same");
    expect(find(rows, "ingredients.1")?.status).toBe("network-only");
  });

  it("orders repeated paths numerically, so 10 follows 9", () => {
    const local: Record<string, string> = {};
    for (let i = 0; i < 12; i++) local[`ingredients.${i}`] = `item ${i}`;
    const paths = compareProjections(local, null)
      .filter((row) => row.path.startsWith("ingredients."))
      .map((row) => row.path);
    expect(paths.slice(8, 12)).toEqual(["ingredients.8", "ingredients.9", "ingredients.10", "ingredients.11"]);
  });

  it("handles a record with no local counterpart at all", () => {
    const rows = compareProjections(null, { name: "Network only" });
    expect(find(rows, "name")).toMatchObject({ local: null, network: "Network only", status: "network-only" });
  });
});
