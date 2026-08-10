import { describe, expect, it } from "vitest";
import { describeDiff, diffLines, summarizeDiff } from "./diff.ts";

/**
 * The client-side comparison (plan §7.6, D21).
 *
 * Two properties matter beyond "it diffs": lines are matched on the same normalization the
 * content fingerprint uses, so formatting noise does not read as a change; and every row
 * carries a marker, because §10.4 forbids fill colour as the only difference cue.
 */

describe("diffLines", () => {
  it("matches lines through the same fold the fingerprint uses", () => {
    // Case, runs of whitespace, accents, and edge punctuation are all noise to
    // `normalizeLine`, so none of these read as a change.
    const rows = diffLines(["  2  CUPS   All-Purpose Flour ", "Crème Brûlée base."], ["2 cups all-purpose flour", "Creme Brulee base"]);
    expect(rows.map((row) => row.status)).toEqual(["same", "same"]);
    expect(summarizeDiff(rows).identical).toBe(true);
  });

  it("renders the verbatim line, not the normalized one", () => {
    const rows = diffLines(["  2  CUPS   All-Purpose Flour "], ["2 cups All-Purpose FLOUR"]);
    // Same line, shown as the incoming side wrote it.
    expect(rows[0].status).toBe("same");
    expect(rows[0].text).toBe("2 cups All-Purpose FLOUR");
  });

  it("calls the incoming side's extra lines `added` and your copy's `removed`", () => {
    const rows = diffLines(["flour", "sugar"], ["flour", "butter", "sugar"]);
    expect(rows.map((row) => [row.status, row.text])).toEqual([
      ["same", "flour"],
      ["added", "butter"],
      ["same", "sugar"],
    ]);

    const removed = diffLines(["flour", "sugar"], ["flour"]);
    expect(removed.map((row) => row.status)).toEqual(["same", "removed"]);
  });

  it("gives every row a readable marker, never colour alone (§10.4)", () => {
    const rows = diffLines(["a"], ["b"]);
    expect(rows.map((row) => row.marker).sort()).toEqual(["+", "−"]);
    // The `same` gutter is one blank character wide, so every row's text starts in the same
    // column whether it differs or not.
    const same = diffLines(["a"], ["a"])[0].marker;
    expect(same).toHaveLength(1);
    expect(same.trim()).toBe("");
  });

  it("handles an empty side", () => {
    expect(diffLines([], ["a", "b"]).map((row) => row.status)).toEqual(["added", "added"]);
    expect(diffLines(["a", "b"], []).map((row) => row.status)).toEqual(["removed", "removed"]);
    expect(summarizeDiff(diffLines([], []))).toEqual({ same: 0, added: 0, removed: 0, identical: true });
  });
});

describe("describeDiff", () => {
  it("says `identical` when nothing differs", () => {
    expect(describeDiff(summarizeDiff(diffLines(["a"], ["a"])), "Pancakes")).toBe("Pancakes: identical.");
  });

  it("counts each kind for the live region", () => {
    const summary = summarizeDiff(diffLines(["flour", "sugar"], ["flour", "butter"]));
    expect(describeDiff(summary, "Pancakes")).toBe("Pancakes: 1 only in the import, 1 only in your copy, 1 the same.");
  });
});
