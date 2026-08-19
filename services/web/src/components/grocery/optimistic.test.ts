import { describe, expect, it } from "vitest";
import type { GroceryItemRow, GroceryListPayload } from "#/lib/api";
import {
  baseQuantity,
  editableQuantity,
  groupByAisle,
  listCounts,
  renderRowQuantity,
  visibleItems,
  withAllCleared,
  withCheckedCleared,
  withItemChecked,
  withItemEdited,
  withItemRemoved,
} from "./optimistic";

/** The load-time timestamp every fixture is written against. */
const READ_AT = "2026-08-17T12:00:00.000Z";
const TTL = 60 * 60;

function item(id: string, overrides: Partial<GroceryItemRow> = {}): GroceryItemRow {
  return {
    id,
    foodSlug: `en:${id}`,
    displayName: id,
    aisle: "produce",
    quantityDisplay: "2",
    quantity: 2,
    unit: null,
    unitDim: "count",
    isManual: false,
    checkedAt: null,
    checkedByHandle: null,
    sources: [],
    ...overrides,
  };
}

function makeList(items: GroceryItemRow[]): GroceryListPayload {
  return { items, readAt: READ_AT, checkedTtlSeconds: TTL };
}

/** An offset from `READ_AT`, in minutes. */
function minutesFromRead(minutes: number): string {
  return new Date(Date.parse(READ_AT) + minutes * 60_000).toISOString();
}

describe("visibleItems (plan D10)", () => {
  it("keeps unchecked rows and rows checked inside the TTL", () => {
    const list = makeList([item("a"), item("b", { checkedAt: minutesFromRead(-30) })]);
    expect(visibleItems(list).map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("hides a row checked before the cutoff", () => {
    const list = makeList([item("a"), item("stale", { checkedAt: minutesFromRead(-61) })]);
    expect(visibleItems(list).map((row) => row.id)).toEqual(["a"]);
  });

  it("measures the cutoff from readAt, not the wall clock", () => {
    // Checked "in the future" relative to the payload — which is exactly what a
    // row checked during this session looks like once the loader has re-run.
    const list = makeList([item("fresh", { checkedAt: minutesFromRead(5) })]);
    expect(visibleItems(list).map((row) => row.id)).toEqual(["fresh"]);
  });

  it("shows everything when readAt is unusable rather than emptying the list", () => {
    const list = { ...makeList([item("a", { checkedAt: minutesFromRead(-600) })]), readAt: "not a date" };
    expect(visibleItems(list)).toHaveLength(1);
  });

  it("survives a row checked during this session, even on a browser whose clock lags", () => {
    const list = makeList([item("a")]);
    // The fixture's `readAt` is a fixed instant with no relation to the test
    // runner's clock, so this covers a browser running behind the server as
    // well as one running with it.
    expect(visibleItems(withItemChecked(list, "a", true)).map((row) => row.id)).toEqual(["a"]);
  });
});

describe("groupByAisle", () => {
  it("orders sections the way the store is walked and skips empty aisles", () => {
    const rows = [item("bread", { aisle: "bakery" }), item("apple", { aisle: "produce" }), item("mystery", { aisle: "other" }), item("beef", { aisle: "meat_seafood" })];
    expect(groupByAisle(rows).map((section) => section.aisle)).toEqual(["produce", "meat_seafood", "bakery", "other"]);
  });

  it("labels each section and keeps insertion order inside one", () => {
    const rows = [item("apple", { aisle: "produce" }), item("leek", { aisle: "produce" })];
    const [section] = groupByAisle(rows);
    expect(section.label).toBe("Produce");
    expect(section.items.map((row) => row.id)).toEqual(["apple", "leek"]);
  });

  it("is empty for an empty list", () => {
    expect(groupByAisle([])).toEqual([]);
  });
});

describe("listCounts", () => {
  it("splits the list into still-to-buy and in-the-cart", () => {
    const rows = [item("a"), item("b", { checkedAt: minutesFromRead(-1) }), item("c")];
    expect(listCounts(rows)).toEqual({ remaining: 2, checked: 1 });
  });
});

describe("quantity round trip", () => {
  it("opens a mass row in its own anchor unit, not in grams", () => {
    // 1 lb 8 oz, stored as grams.
    const row = { quantity: 680.388, unit: "lb", unitDim: "mass" };
    expect(editableQuantity(row)).toBe(1.5);
    expect(renderRowQuantity(row)).toBe("1 lb 8 oz");
  });

  it("converts a typed number back to base units", () => {
    const row = { quantity: 680.388, unit: "lb", unitDim: "mass" };
    const base = baseQuantity(row, 2);
    expect(base).toBeCloseTo(907.18, 2);
    expect(renderRowQuantity(row, base)).toBe("2 lb");
  });

  it("round-trips a volume row through the field unchanged", () => {
    const row = { quantity: 591.47, unit: "cup", unitDim: "volume" };
    const typed = editableQuantity(row);
    expect(typed).toBe(2.5);
    expect(renderRowQuantity(row, baseQuantity(row, typed))).toBe("2½ cups");
  });

  it("treats a discrete unit as its own base — three cloves stay three", () => {
    const row = { quantity: 3, unit: "clove", unitDim: "count" };
    expect(editableQuantity(row)).toBe(3);
    expect(baseQuantity(row, 5)).toBe(5);
    expect(renderRowQuantity(row, 5)).toBe("5 cloves");
  });

  it("leaves an unknown quantity unknown in both directions", () => {
    const row = { quantity: null, unit: null, unitDim: null };
    expect(editableQuantity(row)).toBeNull();
    expect(baseQuantity(row, null)).toBeNull();
    expect(renderRowQuantity(row)).toBeNull();
  });
});

describe("withItemChecked", () => {
  it("stamps and clears the check", () => {
    const list = makeList([item("a")]);
    const checked = withItemChecked(list, "a", true, "@sam");
    expect(checked.items[0].checkedAt).not.toBeNull();
    expect(checked.items[0].checkedByHandle).toBe("@sam");

    const cleared = withItemChecked(checked, "a", false);
    expect(cleared.items[0].checkedAt).toBeNull();
    expect(cleared.items[0].checkedByHandle).toBeNull();
  });

  it("leaves the loader's payload untouched", () => {
    const list = makeList([item("a")]);
    withItemChecked(list, "a", true);
    expect(list.items[0].checkedAt).toBeNull();
  });

  it("is a no-op for an id the list does not contain", () => {
    const list = makeList([item("a")]);
    expect(withItemChecked(list, "ghost", true)).toBe(list);
  });
});

describe("withItemRemoved", () => {
  it("drops the row", () => {
    const list = makeList([item("a"), item("b")]);
    expect(withItemRemoved(list, "a").items.map((row) => row.id)).toEqual(["b"]);
  });

  it("is a no-op for an unknown id", () => {
    const list = makeList([item("a")]);
    expect(withItemRemoved(list, "ghost")).toBe(list);
  });
});

describe("withItemEdited", () => {
  it("re-renders the total from the new quantity", () => {
    const list = makeList([item("chicken", { quantity: 680.388, unit: "lb", unitDim: "mass", quantityDisplay: "1 lb 8 oz" })]);
    const next = withItemEdited(list, "chicken", { quantity: 907.185 });
    expect(next.items[0].quantityDisplay).toBe("2 lb");
    expect(next.items[0].quantity).toBeCloseTo(907.185, 3);
  });

  it("renames without touching the quantity", () => {
    const list = makeList([item("a", { displayName: "scallions" })]);
    const next = withItemEdited(list, "a", { displayName: "  green onions  " });
    expect(next.items[0].displayName).toBe("green onions");
    expect(next.items[0].quantity).toBe(2);
  });

  it("ignores a blank name — the server rejects one too", () => {
    const list = makeList([item("a", { displayName: "scallions" })]);
    expect(withItemEdited(list, "a", { displayName: "   " }).items[0].displayName).toBe("scallions");
  });

  it("clears a quantity to unknown when asked explicitly", () => {
    const list = makeList([item("a")]);
    const next = withItemEdited(list, "a", { quantity: null });
    expect(next.items[0].quantity).toBeNull();
    expect(next.items[0].quantityDisplay).toBeNull();
  });

  it("is a no-op for an unknown id", () => {
    const list = makeList([item("a")]);
    expect(withItemEdited(list, "ghost", { displayName: "x" })).toBe(list);
  });
});

describe("withCheckedCleared", () => {
  it("sweeps every checked row at once", () => {
    const list = makeList([item("a"), item("b", { checkedAt: minutesFromRead(-1) }), item("c", { checkedAt: minutesFromRead(-2) })]);
    expect(withCheckedCleared(list).items.map((row) => row.id)).toEqual(["a"]);
  });

  it("is a no-op when nothing is checked", () => {
    const list = makeList([item("a")]);
    expect(withCheckedCleared(list)).toBe(list);
  });
});

describe("withAllCleared", () => {
  it("takes the unchecked rows too — that is the whole difference from clearing checked", () => {
    const list = makeList([item("a"), item("b", { checkedAt: minutesFromRead(-1) })]);
    expect(withAllCleared(list).items).toEqual([]);
  });

  it("is a no-op on an already empty list", () => {
    const list = makeList([]);
    expect(withAllCleared(list)).toBe(list);
  });
});
