import { describe, expect, it } from "vitest";
import { applyVisibleOrder, moveByKey, moveItem, moveToInsertionPoint } from "./reorder";

const list = ["a", "b", "c", "d"];

describe("moveItem", () => {
  it("moves an item forwards", () => {
    expect(moveItem(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves an item backwards", () => {
    expect(moveItem(list, 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("clamps past either end", () => {
    expect(moveItem(list, 2, -5)).toEqual(["c", "a", "b", "d"]);
    expect(moveItem(list, 0, 99)).toEqual(["b", "c", "d", "a"]);
  });

  it("returns the same array when nothing moves", () => {
    expect(moveItem(list, 1, 1)).toBe(list);
    expect(moveItem(list, 9, 0)).toBe(list);
    expect(moveItem(list, -1, 0)).toBe(list);
  });

  it("never mutates its input", () => {
    const input = [...list];
    moveItem(input, 0, 3);
    expect(input).toEqual(list);
  });
});

describe("moveToInsertionPoint", () => {
  it("treats the gap as a gap, not an index, when travelling down", () => {
    // "b" dropped into the gap after "c" lands third, not fourth.
    expect(moveToInsertionPoint(list, 1, 3)).toEqual(["a", "c", "b", "d"]);
  });

  it("travels up without the shift", () => {
    expect(moveToInsertionPoint(list, 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("accepts the gap past the last row", () => {
    expect(moveToInsertionPoint(list, 0, 4)).toEqual(["b", "c", "d", "a"]);
  });

  it("is a no-op for the two gaps that mean 'where it already is'", () => {
    expect(moveToInsertionPoint(list, 1, 1)).toBe(list);
    expect(moveToInsertionPoint(list, 1, 2)).toBe(list);
  });
});

describe("moveByKey", () => {
  it("steps one place in each direction", () => {
    expect(moveByKey(list, 2, "up")).toEqual(["a", "c", "b", "d"]);
    expect(moveByKey(list, 2, "down")).toEqual(["a", "b", "d", "c"]);
  });

  it("goes all the way to an end", () => {
    expect(moveByKey(list, 2, "top")).toEqual(["c", "a", "b", "d"]);
    expect(moveByKey(list, 1, "bottom")).toEqual(["a", "c", "d", "b"]);
  });

  it("stops at the ends rather than wrapping", () => {
    expect(moveByKey(list, 0, "up")).toBe(list);
    expect(moveByKey(list, 3, "down")).toBe(list);
  });
});

describe("applyVisibleOrder", () => {
  const full = ["a", "b", "c", "d", "e"];

  it("writes the whole order back, not the rendered subset", () => {
    // "b" and "d" are not in the box any more, so the ledger never rendered
    // them — swapping "c" and "e" must not drop them from the collection.
    const next = applyVisibleOrder(full, ["a", "e", "c"]);
    expect(next).toEqual(["a", "b", "e", "d", "c"]);
    expect(next).toHaveLength(full.length);
    expect([...next].sort()).toEqual([...full].sort());
  });

  it("keeps hidden ids in their absolute slots", () => {
    expect(applyVisibleOrder(full, ["c", "a"])).toEqual(["c", "b", "a", "d", "e"]);
  });

  it("is the plain new order when everything is visible", () => {
    expect(applyVisibleOrder(full, ["e", "d", "c", "b", "a"])).toEqual(["e", "d", "c", "b", "a"]);
  });

  it("ignores ids the collection does not hold", () => {
    expect(applyVisibleOrder(full, ["c", "ghost", "a"])).toEqual(["c", "b", "a", "d", "e"]);
  });

  it("ignores a repeated id rather than duplicating an entry", () => {
    expect(applyVisibleOrder(full, ["c", "c", "a"])).toEqual(["c", "b", "a", "d", "e"]);
  });

  it("leaves the order alone when the subset names nothing", () => {
    expect(applyVisibleOrder(full, [])).toEqual(full);
  });
});

/**
 * The two moves the collections feature actually makes, end to end — the exact
 * composition the ledger and the tree perform, because the bug worth guarding
 * against is not in either function but in pairing them wrongly.
 */
describe("a reorder, as the collections UI performs it", () => {
  it("a drag in a collection-scoped ledger writes the FULL entry order", () => {
    // The collection holds five entries; two of their recipes have left the box,
    // so the ledger only ever rendered three rows.
    const entries = ["a", "gone-1", "b", "gone-2", "c"];
    const rendered = ["a", "b", "c"];
    // "c" is dragged to the very top: insertion point 0 over the rendered rows.
    const next = applyVisibleOrder(entries, moveToInsertionPoint(rendered, 2, 0));
    expect(next).toEqual(["c", "gone-1", "a", "gone-2", "b"]);
    expect(next).toHaveLength(entries.length);
  });

  it("a keyboard move in the same ledger keeps the unrendered entries too", () => {
    const entries = ["a", "gone-1", "b", "c"];
    const rendered = ["a", "b", "c"];
    expect(applyVisibleOrder(entries, moveByKey(rendered, 0, "bottom"))).toEqual(["b", "gone-1", "c", "a"]);
  });

  it("a drag in the tree is the whole list by construction", () => {
    // Every collection is rendered, so the fold-back is the identity.
    const shelves = ["weeknights", "baking", "sunday"];
    const moved = moveToInsertionPoint(shelves, 2, 0);
    expect(moved).toEqual(["sunday", "weeknights", "baking"]);
    expect(applyVisibleOrder(shelves, moved)).toEqual(moved);
  });
});
