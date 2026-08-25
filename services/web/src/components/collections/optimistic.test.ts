import { describe, expect, it } from "vitest";
import type { CollectionSummary } from "#/lib/api";
import { withCollectionEdited, withCollectionRecipesReordered, withCollectionsReordered, withRecipeUnfiled, withRecipeUnfiledEverywhere, withRecipesFiled } from "./optimistic";

/**
 * The pure cache patches behind the collection mutations (collections plan §9).
 *
 * Two properties every case here is really checking: the patch preserves the
 * invariants the server maintains (`position` dense `0..n-1`, `recipeIds` in
 * entry order), and it leaves the input array untouched — the payload is shared
 * with the query cache, and a patch that mutated it would corrupt the snapshot
 * `onError` restores from.
 */

function collection(id: string, overrides: Partial<CollectionSummary> = {}): CollectionSummary {
  return {
    id,
    name: id,
    description: null,
    position: 0,
    recipeIds: [],
    createdByDid: "did:test:author",
    publishedByDid: null,
    publishedByHandle: null,
    publishedAt: null,
    recordStale: false,
    uri: null,
    ...overrides,
  };
}

/** A household list, positions stamped densely the way the server returns them. */
function list(...collections: CollectionSummary[]): CollectionSummary[] {
  return collections.map((entry, position) => ({ ...entry, position }));
}

describe("withCollectionEdited", () => {
  it("renames a collection and leaves its siblings alone", () => {
    const before = list(collection("a"), collection("b"));
    const after = withCollectionEdited(before, "a", { name: "Weeknights" });
    expect(after.map((entry) => entry.name)).toEqual(["Weeknights", "b"]);
    expect(after[1]).toBe(before[1]);
  });

  it("trims the name the way the server's validator does", () => {
    const after = withCollectionEdited(list(collection("a")), "a", { name: "  Sunday Baking  " });
    expect(after[0].name).toBe("Sunday Baking");
  });

  it("ignores a blank name rather than showing a nameless row", () => {
    const after = withCollectionEdited(list(collection("a", { name: "Weeknights" })), "a", { name: "   " });
    expect(after[0].name).toBe("Weeknights");
  });

  it("leaves the description alone when it is omitted, and clears it on null or blank", () => {
    const before = list(collection("a", { description: "quick ones" }));
    expect(withCollectionEdited(before, "a", { name: "x" })[0].description).toBe("quick ones");
    expect(withCollectionEdited(before, "a", { description: null })[0].description).toBeNull();
    expect(withCollectionEdited(before, "a", { description: "  " })[0].description).toBeNull();
  });

  it("is a no-op for an id the list does not hold", () => {
    const before = list(collection("a"));
    expect(withCollectionEdited(before, "gone", { name: "x" })).toBe(before);
  });
});

describe("withCollectionsReordered", () => {
  it("applies the requested order and restamps position densely", () => {
    const before = list(collection("a"), collection("b"), collection("c"));
    const after = withCollectionsReordered(before, ["c", "a", "b"]);
    expect(after.map((entry) => entry.id)).toEqual(["c", "a", "b"]);
    expect(after.map((entry) => entry.position)).toEqual([0, 1, 2]);
  });

  it("appends collections the client never mentioned, in their existing order", () => {
    // Someone else created "d" between the render and the drop.
    const before = list(collection("a"), collection("b"), collection("c"), collection("d"));
    const after = withCollectionsReordered(before, ["c", "a"]);
    expect(after.map((entry) => entry.id)).toEqual(["c", "a", "b", "d"]);
    expect(after.map((entry) => entry.position)).toEqual([0, 1, 2, 3]);
  });

  it("drops ids that are no longer there, and duplicates", () => {
    const before = list(collection("a"), collection("b"));
    const after = withCollectionsReordered(before, ["b", "gone", "b", "a"]);
    expect(after.map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("does not mutate the array it was given", () => {
    const before = list(collection("a"), collection("b"));
    withCollectionsReordered(before, ["b", "a"]);
    expect(before.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(before.map((entry) => entry.position)).toEqual([0, 1]);
  });
});

describe("withCollectionRecipesReordered", () => {
  it("reorders one collection's membership and leaves the rest alone", () => {
    const before = list(collection("a", { recipeIds: ["r1", "r2", "r3"] }), collection("b", { recipeIds: ["r9"] }));
    const after = withCollectionRecipesReordered(before, "a", ["r3", "r1", "r2"]);
    expect(after[0].recipeIds).toEqual(["r3", "r1", "r2"]);
    expect(after[1]).toBe(before[1]);
  });

  it("appends unmentioned members and ignores unknown ids", () => {
    const before = list(collection("a", { recipeIds: ["r1", "r2", "r3"] }));
    expect(withCollectionRecipesReordered(before, "a", ["r3", "nope"])[0].recipeIds).toEqual(["r3", "r1", "r2"]);
  });

  it("is a no-op for an id the list does not hold", () => {
    const before = list(collection("a"));
    expect(withCollectionRecipesReordered(before, "gone", ["r1"])).toBe(before);
  });
});

describe("withRecipesFiled", () => {
  it("appends at the bottom in the order given", () => {
    const before = list(collection("a", { recipeIds: ["r1"] }));
    expect(withRecipesFiled(before, "a", ["r3", "r2"])[0].recipeIds).toEqual(["r1", "r3", "r2"]);
  });

  it("skips already-filed ids rather than moving them (§8)", () => {
    const before = list(collection("a", { recipeIds: ["r1", "r2"] }));
    expect(withRecipesFiled(before, "a", ["r2", "r3"])[0].recipeIds).toEqual(["r1", "r2", "r3"]);
  });

  it("files a repeated id once", () => {
    const before = list(collection("a"));
    expect(withRecipesFiled(before, "a", ["r1", "r1"])[0].recipeIds).toEqual(["r1"]);
  });

  it("returns the same collection object when nothing is new", () => {
    const before = list(collection("a", { recipeIds: ["r1"] }));
    expect(withRecipesFiled(before, "a", ["r1"])[0]).toBe(before[0]);
  });
});

describe("withRecipeUnfiled", () => {
  it("removes the recipe from just that collection", () => {
    const before = list(collection("a", { recipeIds: ["r1", "r2"] }), collection("b", { recipeIds: ["r1"] }));
    const after = withRecipeUnfiled(before, "a", "r1");
    expect(after[0].recipeIds).toEqual(["r2"]);
    expect(after[1].recipeIds).toEqual(["r1"]);
  });

  it("is a no-op when the recipe was never filed there", () => {
    const before = list(collection("a", { recipeIds: ["r1"] }));
    expect(withRecipeUnfiled(before, "a", "r9")[0]).toBe(before[0]);
  });
});

describe("withRecipeUnfiledEverywhere (§2.11)", () => {
  it("unfiles the recipe from every collection that held it", () => {
    const before = list(collection("a", { recipeIds: ["r1", "r2"] }), collection("b", { recipeIds: ["r1"] }), collection("c", { recipeIds: ["r3"] }));
    const after = withRecipeUnfiledEverywhere(before, "r1");
    expect(after.map((entry) => entry.recipeIds)).toEqual([["r2"], [], ["r3"]]);
  });

  it("is a no-op when no collection held it", () => {
    const before = list(collection("a", { recipeIds: ["r1"] }));
    expect(withRecipeUnfiledEverywhere(before, "r9")).toBe(before);
  });
});
