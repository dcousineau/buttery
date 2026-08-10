import { describe, expect, it } from "vitest";
import type { ImportCandidate } from "@buttery/recipe-extract/import";
import { choiceToAttribution, initialState, isGroupAnswered, reduce, type GroupChoice, type ImportEvent, type ImportState } from "./machine.ts";
import type { ParsedItem } from "./worker-protocol.ts";
import {
  buildSourceGroups,
  copyAnswerEdits,
  liveSourceGroups,
  MISSPELLING_THRESHOLD,
  NO_SOURCE_GROUP_KEY,
  splitPageReference,
  stringSimilarity,
  type GroupableCandidate,
} from "./source-groups.ts";

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

function run(state: ImportState, ...events: ImportEvent[]): ImportState {
  return events.reduce(reduce, state);
}

/** A review-phase state holding two near-identical source strings, one recipe each. */
function twoSpellings(): ImportState {
  const items: ParsedItem[] = ["Gordon Ramsay", "Godon Ramsey"].map((sourceText, index) => {
    const recipe: ImportCandidate = {
      kind: "candidate",
      clientId: `c${index}`,
      recipe: { name: `Recipe ${index}`, ingredients: ["1 egg"], instructions: ["Mix."] },
      sourceUrl: null,
      sourceText,
      notes: null,
      tags: [],
      imageUrl: null,
      localImagePath: null,
      entryName: `Recipe ${index}.html`,
      meta: {},
    };
    return { candidate: recipe, sourceUrlKey: null, contentFp: `sha256:${recipe.clientId}` };
  });

  return run(
    initialState("fixture"),
    { type: "drop_accepted", fileName: "My Recipes" },
    { type: "session_opened", sessionId: "s1" },
    { type: "parse_complete", result: { items, failures: [] } },
    { type: "probe_complete", verdicts: items.map((item) => ({ clientId: item.candidate.clientId, verdict: "new" as const })) },
  );
}

/** Exactly what the button dispatches: the copied answer, as chip-and-keystroke events. */
function copyEvents(state: ImportState, fromKey: string, toKey: string): ImportEvent[] {
  const edits = copyAnswerEdits(state.groupChoices[fromKey]);
  if (!edits) return [];
  return [
    { type: "set_group_kind", groupKey: toKey, kind: edits.kind },
    ...edits.fields.map((edit): ImportEvent => ({ type: "set_group_field", groupKey: toKey, field: edit.field, value: edit.value })),
  ];
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
    const groups = buildSourceGroups([candidate("a", "Gordon Ramsay"), candidate("b", "Gordon Ramsay"), candidate("c", "Godon Ramsey")]);

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
    const groups = buildSourceGroups([
      candidate("a", "One"),
      candidate("b", "Two"),
      candidate("c", "Two"),
      candidate("d", "Three"),
      candidate("e", "Three"),
      candidate("f", "Three"),
    ]);
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

/**
 * "Copy from that source" (§10.2). The hint points at a group above; once *that* group is
 * answered, the card offers to take the same answer.
 *
 * The rule these tests exist to hold: a copy is not a new way to write an answer. It is
 * replayed as the very `set_group_kind` / `set_group_field` events a chip click and a
 * keystroke send, so anything answering by hand does — including "Skip these" deciding the
 * recipes' fate — a copy does too, for free and without a second code path to keep in sync.
 */
describe("copyAnswerEdits", () => {
  const book: GroupChoice = {
    kind: "publication",
    publicationTitle: "Ramsay's Home Cooking",
    publicationAuthor: "Gordon Ramsay",
    // The other chips' prefills are the *target's* own text, and copying a book answer must
    // not drag these across.
    personName: "Gordon Ramsay",
    websiteName: "Gordon Ramsay",
    websiteUrl: "",
  };

  it("copies the chip and only the fields that chip carries", () => {
    expect(copyAnswerEdits(book)).toEqual({
      kind: "publication",
      fields: [
        { field: "publicationTitle", value: "Ramsay's Home Cooking" },
        { field: "publicationAuthor", value: "Gordon Ramsay" },
      ],
    });
    expect(copyAnswerEdits({ ...book, kind: "website", websiteUrl: "https://example.com/x" })).toEqual({
      kind: "website",
      fields: [
        { field: "websiteName", value: "Gordon Ramsay" },
        { field: "websiteUrl", value: "https://example.com/x" },
      ],
    });
    // "Skip these" is answered by the chip alone.
    expect(copyAnswerEdits({ ...book, kind: "skip" })).toEqual({ kind: "skip", fields: [] });
  });

  it("has nothing to copy from a group nobody has answered", () => {
    expect(copyAnswerEdits({ ...book, kind: null })).toBeNull();
    expect(copyAnswerEdits(undefined)).toBeNull();
  });

  it("leaves the copied-onto group reading exactly as the one it copied from", () => {
    let state = twoSpellings();
    const [source, target] = state.groups;
    expect(target.similarTo).toBe(source.key); // the hint the button hangs off

    state = run(
      state,
      { type: "set_group_kind", groupKey: source.key, kind: "publication" },
      { type: "set_group_field", groupKey: source.key, field: "publicationTitle", value: "Ramsay's Home Cooking" },
      { type: "set_group_field", groupKey: source.key, field: "publicationAuthor", value: "Gordon Ramsay" },
    );
    expect(isGroupAnswered(state.groupChoices[target.key])).toBe(false);

    state = run(state, ...copyEvents(state, source.key, target.key));

    expect(isGroupAnswered(state.groupChoices[target.key])).toBe(true);
    expect(choiceToAttribution(state.groupChoices[target.key])).toEqual(choiceToAttribution(state.groupChoices[source.key]));
    // The misspelling is still its own group with its own verbatim string — copying an
    // answer is not merging (§8.2).
    expect(state.groups.map((group) => group.key)).toEqual([source.key, target.key]);
  });

  it("carries the consequences of the answer, not just its text", () => {
    // "Skip these" decides the recipes' fate rather than their attribution. Copying it has
    // to leave this group's recipes behind too, which it does only because the copy goes
    // out as `set_group_kind`.
    let state = twoSpellings();
    const [source, target] = state.groups;
    state = run(state, { type: "set_group_kind", groupKey: source.key, kind: "skip" });
    state = run(state, ...copyEvents(state, source.key, target.key));

    const actions = state.items.filter((item) => target.clientIds.includes(item.clientId)).map((item) => item.action);
    expect(actions).toEqual(["skip"]);
  });
});

describe("liveSourceGroups", () => {
  it("drops the recipes that are no longer being written, and any group left empty", () => {
    const groups = buildSourceGroups([candidate("a", "Nana"), candidate("b", "Nana"), candidate("c", "Mum")]);
    const live = liveSourceGroups(groups, (clientId) => clientId === "b");
    expect(live.map((group) => [group.key, group.clientIds])).toEqual([["Nana", ["b"]]]);
  });

  it("clears a misspelling hint that would point at a group no longer on screen", () => {
    // "Looks like a spelling of X above" is a literal instruction to the reader; leaving it
    // pointing at a card that is not there is worse than not hinting at all.
    const groups = buildSourceGroups([candidate("a", "Gordon Ramsay"), candidate("b", "Gordon Ramsey")]);
    expect(groups[1].similarTo).toBe("Gordon Ramsay");
    expect(liveSourceGroups(groups, (clientId) => clientId === "b")[0].similarTo).toBeNull();
    expect(liveSourceGroups(groups, () => true)[1].similarTo).toBe("Gordon Ramsay");
  });
});
