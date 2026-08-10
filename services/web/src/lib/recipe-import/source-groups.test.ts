import { describe, expect, it } from "vitest";
import { buildSourceGroups, MISSPELLING_THRESHOLD, NO_SOURCE_GROUP_KEY, splitPageReference, stringSimilarity, type GroupableCandidate } from "./source-groups.ts";

/**
 * Bulk attribution grouping (plan §8) and the two string affordances §10.2 pulled off the
 * optional list.
 *
 * The behaviour worth pinning down is what grouping refuses to do: it never merges two
 * spellings, never answers on the user's behalf, and never drops the page reference — all
 * three are §8.2 promises about what reaches a record.
 */

function candidate(clientId: string, sourceText: string | null, sourceUrl: string | null = null): GroupableCandidate {
  return { clientId, sourceText, sourceUrl };
}

describe("splitPageReference", () => {
  it("splits a trailing page reference off a book title", () => {
    expect(splitPageReference("Ottolenghi Simple pg 174")).toEqual({ title: "Ottolenghi Simple", page: "pg 174" });
    expect(splitPageReference("Ottolenghi Simple, p. 174")).toEqual({ title: "Ottolenghi Simple", page: "p. 174" });
    expect(splitPageReference("Salt Fat Acid Heat — pages 88-90")).toEqual({ title: "Salt Fat Acid Heat", page: "pages 88-90" });
  });

  it("leaves anything that is not a page reference alone", () => {
    expect(splitPageReference("Ottolenghi Simple")).toEqual({ title: "Ottolenghi Simple", page: null });
    // A title that genuinely ends in a number: the digits are not preceded by a page word.
    expect(splitPageReference("Cook's Illustrated 2019")).toEqual({ title: "Cook's Illustrated 2019", page: null });
    // A string that is *only* a page reference has no title to prefill.
    expect(splitPageReference("pg 174")).toEqual({ title: "pg 174", page: null });
  });
});

describe("stringSimilarity", () => {
  it("compares on letters, not on capitalization or punctuation", () => {
    expect(stringSimilarity("Gordon Ramsay", "gordon  ramsay!")).toBe(1);
    expect(stringSimilarity("Gordon Ramsay", "Godon Ramsey")).toBeGreaterThanOrEqual(MISSPELLING_THRESHOLD);
    expect(stringSimilarity("Ottolenghi Simple", "Gordon Ramsay")).toBeLessThan(MISSPELLING_THRESHOLD);
  });
});

describe("buildSourceGroups", () => {
  it("groups on the exact string and never merges spellings", () => {
    const groups = buildSourceGroups([
      candidate("a", "Gordon Ramsay"),
      candidate("b", "Gordon Ramsay"),
      candidate("c", "Godon Ramsey"),
    ]);

    expect(groups.map((group) => group.key)).toEqual(["Gordon Ramsay", "Godon Ramsey"]);
    expect(groups[0].clientIds).toEqual(["a", "b"]);
    // The near-miss is flagged as a hint pointing *backwards*, and stays its own group.
    expect(groups[1].similarTo).toBe("Gordon Ramsay");
    expect(groups[0].similarTo).toBeNull();
  });

  it("skips candidates whose URL already answers attribution (§8.2)", () => {
    const groups = buildSourceGroups([candidate("a", "seriouseats.com", "https://seriouseats.com/x"), candidate("b", "Mum")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("Mum");
  });

  it("gives the recipes with no source at all a real group (§10.3)", () => {
    const groups = buildSourceGroups([candidate("a", null), candidate("b", "   "), candidate("c", "Mum")]);
    const noSource = groups.find((group) => group.key === NO_SOURCE_GROUP_KEY)!;
    expect(noSource.sourceText).toBeNull();
    // Whitespace-only is "no source", not its own string.
    expect(noSource.clientIds).toEqual(["a", "b"]);
    expect(noSource.titlePrefill).toBe("");
  });

  it("orders by recipe count so the biggest decision comes first", () => {
    const groups = buildSourceGroups([candidate("a", "One"), candidate("b", "Two"), candidate("c", "Two"), candidate("d", "Three"), candidate("e", "Three"), candidate("f", "Three")]);
    expect(groups.map((group) => [group.key, group.clientIds.length])).toEqual([
      ["Three", 3],
      ["Two", 2],
      ["One", 1],
    ]);
  });

  it("prefills the title from the page split without losing the page reference", () => {
    const [group] = buildSourceGroups([candidate("a", "Ottolenghi Simple pg 174")]);
    expect(group.sourceText).toBe("Ottolenghi Simple pg 174"); // verbatim — this is what the sidecar keeps
    expect(group.titlePrefill).toBe("Ottolenghi Simple");
    expect(group.pageReference).toBe("pg 174");
  });
});
