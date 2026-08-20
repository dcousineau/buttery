import { describe, expect, it } from "vitest";
import type { CollectionSummary, HouseholdRecipeRow } from "#/lib/api";
import { isDefaultScope, resolveScope, scopeLabel, scopeRows, searchRows, smartScopeCount, smartScopeRows } from "./scope";

/**
 * The scope math — collections plan §7's "scope semantics" clause, which is the
 * whole of what the desktop ledger does with the two cached queries.
 *
 * It is unit-tested rather than clicked through because it is the one part of
 * milestone 2 that is pure: a wrong answer here shows up as a recipe missing
 * from a shelf, which is exactly the class of bug that is invisible until
 * someone goes looking for a specific dinner.
 */

function recipe(recipeId: string, overrides: Partial<HouseholdRecipeRow> = {}): HouseholdRecipeRow {
  return {
    recipeId,
    title: recipeId,
    favorite: false,
    sourceKind: "note",
    sourceLabel: "Written by hand",
    sourceUrl: null,
    totalMinutes: null,
    totalTimeDisplay: null,
    keywords: [],
    thumbUrl: null,
    addedAt: "2026-01-01T00:00:00.000Z",
    addedByHandle: null,
    unavailable: false,
    unpublished: false,
    ...overrides,
  };
}

function collection(id: string, recipeIds: string[]): CollectionSummary {
  return {
    id,
    name: id,
    description: null,
    position: 0,
    recipeIds,
    createdByDid: "did:test:author",
    publishedByDid: null,
    publishedByHandle: null,
    publishedAt: null,
    recordStale: false,
    uri: null,
  };
}

const box = [
  recipe("carbonara", { title: "Carbonara", addedAt: "2026-03-01T00:00:00.000Z", favorite: true, keywords: ["pasta"] }),
  recipe("apple-pie", { title: "Apple pie", addedAt: "2026-05-01T00:00:00.000Z", unpublished: true }),
  recipe("borscht", { title: "Borscht", addedAt: "2026-04-01T00:00:00.000Z", sourceLabel: "nytimes.com" }),
];

describe("resolveScope", () => {
  it("defaults to the whole box, A–Z, when nothing is in the URL", () => {
    expect(resolveScope({}, [])).toEqual({ kind: "smart", scope: "mine" });
  });

  it("lets ?c= win over ?scope=", () => {
    const weeknights = collection("weeknights", []);
    expect(resolveScope({ scope: "favorites", c: "weeknights" }, [weeknights])).toEqual({ kind: "collection", collection: weeknights });
  });

  it("reports a deleted collection as its own state, never as the default scope", () => {
    expect(resolveScope({ c: "gone" }, [collection("weeknights", [])])).toEqual({ kind: "missing-collection", collectionId: "gone" });
  });

  it("ignores an empty ?c=", () => {
    expect(resolveScope({ c: "", scope: "recent" }, [])).toEqual({ kind: "smart", scope: "recent" });
  });
});

describe("smartScopeRows", () => {
  it("sorts `mine` A–Z over the whole box", () => {
    expect(smartScopeRows(box, "mine").map((r) => r.title)).toEqual(["Apple pie", "Borscht", "Carbonara"]);
  });

  it("sorts `recent` by addedAt descending", () => {
    expect(smartScopeRows(box, "recent").map((r) => r.title)).toEqual(["Apple pie", "Borscht", "Carbonara"]);
  });

  it("filters `favorites` and `unpublished` before sorting", () => {
    expect(smartScopeRows(box, "favorites").map((r) => r.recipeId)).toEqual(["carbonara"]);
    expect(smartScopeRows(box, "unpublished").map((r) => r.recipeId)).toEqual(["apple-pie"]);
  });

  it("never mutates the box it was handed", () => {
    const before = box.map((r) => r.recipeId);
    smartScopeRows(box, "recent");
    expect(box.map((r) => r.recipeId)).toEqual(before);
  });
});

describe("scopeRows", () => {
  it("keeps a collection in entry order rather than sorting it", () => {
    const scope = resolveScope({ c: "weeknights" }, [collection("weeknights", ["carbonara", "apple-pie"])]);
    expect(scopeRows(box, scope).map((r) => r.recipeId)).toEqual(["carbonara", "apple-pie"]);
  });

  it("drops members that are no longer in the box", () => {
    const scope = resolveScope({ c: "weeknights" }, [collection("weeknights", ["carbonara", "removed-from-box"])]);
    expect(scopeRows(box, scope).map((r) => r.recipeId)).toEqual(["carbonara"]);
  });

  it("shows nothing for a collection that no longer exists", () => {
    expect(scopeRows(box, { kind: "missing-collection", collectionId: "gone" })).toEqual([]);
  });
});

describe("searchRows", () => {
  it("matches title, source label and keywords", () => {
    expect(searchRows(box, "pasta").map((r) => r.recipeId)).toEqual(["carbonara"]);
    expect(searchRows(box, "nytimes").map((r) => r.recipeId)).toEqual(["borscht"]);
    expect(searchRows(box, "apple").map((r) => r.recipeId)).toEqual(["apple-pie"]);
  });

  it("returns the same array when the query is blank", () => {
    expect(searchRows(box, "   ")).toBe(box);
  });
});

describe("labels and counts", () => {
  it("names every scope", () => {
    expect(scopeLabel({ kind: "smart", scope: "unpublished" })).toBe("Unpublished");
    expect(scopeLabel({ kind: "collection", collection: collection("weeknights", []) })).toBe("weeknights");
    expect(scopeLabel({ kind: "missing-collection", collectionId: "gone" })).toBe("Collection not found");
  });

  it("only calls the landing view default", () => {
    expect(isDefaultScope({ kind: "smart", scope: "mine" })).toBe(true);
    expect(isDefaultScope({ kind: "smart", scope: "recent" })).toBe(false);
    expect(isDefaultScope({ kind: "missing-collection", collectionId: "gone" })).toBe(false);
  });

  it("counts each smart row the way its filter does", () => {
    expect(smartScopeCount(box, "mine")).toBe(3);
    expect(smartScopeCount(box, "recent")).toBe(3);
    expect(smartScopeCount(box, "favorites")).toBe(1);
    expect(smartScopeCount(box, "unpublished")).toBe(1);
  });
});
