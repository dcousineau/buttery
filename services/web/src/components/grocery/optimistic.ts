import type { GroceryItemRow, GroceryListPayload } from "#/lib/api";
import { AISLE_LABELS, type Aisle, aisleOrder } from "#/lib/grocery/aisles";
import { type UnitDim, renderQuantity, resolveUnit } from "#/lib/grocery/units";

/**
 * Pure patches and read helpers over a `GroceryListPayload` — the optimistic
 * half of the grocery route, and the same shape `components/plan/optimistic.ts`
 * takes for the planner.
 *
 * Everything here is a pure function of the payload the loader returned plus the
 * change the shopper just asked for. Nothing touches the network, React or the
 * router: the route holds the patched list through `useOptimistic` and drops it
 * the moment the real one lands. That split is what lets the tricky parts (the
 * D10 visibility cutoff, the base-unit ↔ typed-unit round trip) be unit-tested
 * without a browser.
 *
 * Nothing is mutated in place — the loader's payload is shared with the router
 * cache, so every patch rebuilds the `items` array and only the row it touches.
 * Every patch is a no-op for an id the list does not contain, which is what
 * makes React's re-application of a still-pending patch on top of a newer
 * payload harmless.
 */

/** Enough of a row to render or edit its quantity. Both the list rows and the
 * preview dialog's candidate rows satisfy it, so the unit maths is written once. */
export interface QuantityShape {
  /** Total in base units (ml / g / bare count). */
  quantity: number | null;
  /** The anchor unit id the row renders in — `lb`, `cup`, `clove`, or `null`. */
  unit: string | null;
  unitDim: string | null;
}

/** One aisle's worth of rows, ready to render. */
export interface AisleSection {
  aisle: Aisle;
  label: string;
  items: GroceryItemRow[];
}

/**
 * Coerce the stored `unit_dim` string to a dimension. Mirrors the server's own
 * `renderTotal` fallback: a CHECK constraint already guarantees the column, and
 * a list that renders is worth more than one that is right about its schema.
 */
export function toUnitDim(unitDim: string | null): UnitDim {
  return unitDim === "volume" || unitDim === "mass" ? unitDim : "count";
}

/** Re-render a row's total after an inline edit, the way the server would. */
export function renderRowQuantity(row: QuantityShape, quantity: number | null = row.quantity): string | null {
  if (quantity == null) return null;
  return renderQuantity(quantity, toUnitDim(row.unitDim), row.unit);
}

/**
 * The number an inline edit puts in the field.
 *
 * Rows are stored in base units (grams, millilitres) but nobody edits a chicken
 * breast in grams — the field speaks the row's own anchor unit, so a row reading
 * `1 lb 8 oz` opens as `1.5` beside a fixed `lb`. Rounding to three decimals
 * keeps the conversion's floating-point tail (`1.4999999…`) out of the field;
 * three is finer than any quantity anyone writes and coarse enough to be clean.
 */
export function editableQuantity(row: QuantityShape): number | null {
  if (row.quantity == null) return null;
  const factor = resolveUnit(row.unit).factor ?? 1;
  return Math.round((row.quantity / factor) * 1000) / 1000;
}

/** The inverse of {@link editableQuantity}: a typed number back to base units. */
export function baseQuantity(row: QuantityShape, typed: number | null): number | null {
  if (typed == null) return null;
  const factor = resolveUnit(row.unit).factor ?? 1;
  return typed * factor;
}

/**
 * The unit the edit field is denominated in, shown beside it as fixed text.
 *
 * It is deliberately not editable: `unit` is the merge anchor the row was built
 * on, and letting someone retype `lb` as `cups` would silently invent a
 * conversion the engine refuses to make (plan D5).
 */
export function editableUnitLabel(row: QuantityShape): string | null {
  return row.unit;
}

/**
 * The rows the list should show right now (plan D10).
 *
 * A checked row dims in place and stays put until it falls out of the TTL, and
 * the cutoff is computed from the payload's own `readAt` rather than a live
 * clock. That is the whole trick: `readAt` only moves when a load moves it, so a
 * row checked during this session sits comfortably inside the window and cannot
 * vanish out from under the thumb that just checked it — while a row checked an
 * hour ago in someone else's session is gone by the time this payload arrives.
 *
 * The server applies the identical filter with `now()`, so this is a second pass
 * over an already-filtered set, not the only gate.
 */
export function visibleItems(list: GroceryListPayload): GroceryItemRow[] {
  const readAt = Date.parse(list.readAt);
  // An unparseable `readAt` is not a reason to hide anybody's groceries.
  if (!Number.isFinite(readAt)) return list.items;
  const cutoff = readAt - list.checkedTtlSeconds * 1000;
  return list.items.filter((item) => {
    if (item.checkedAt == null) return true;
    const checkedAt = Date.parse(item.checkedAt);
    return !Number.isFinite(checkedAt) || checkedAt > cutoff;
  });
}

/** Group rows into aisle sections in canonical order, skipping empty aisles. */
export function groupByAisle(items: GroceryItemRow[]): AisleSection[] {
  const byAisle = new Map<Aisle, GroceryItemRow[]>();
  for (const item of items) {
    const bucket = byAisle.get(item.aisle) ?? [];
    bucket.push(item);
    byAisle.set(item.aisle, bucket);
  }
  return [...byAisle.entries()].sort(([a], [b]) => aisleOrder(a) - aisleOrder(b)).map(([aisle, rows]) => ({ aisle, label: AISLE_LABELS[aisle], items: rows }));
}

/** What the header counts: still to buy, and already in the cart. */
export function listCounts(items: GroceryItemRow[]): { remaining: number; checked: number } {
  let checked = 0;
  for (const item of items) if (item.checkedAt) checked += 1;
  return { remaining: items.length - checked, checked };
}

/** Replace one row, leaving the payload alone when the id is not on the list. */
function withItemPatched(list: GroceryListPayload, itemId: string, patch: (item: GroceryItemRow) => GroceryItemRow): GroceryListPayload {
  if (!list.items.some((item) => item.id === itemId)) return list;
  return { ...list, items: list.items.map((item) => (item.id === itemId ? patch(item) : item)) };
}

/**
 * Check or uncheck a row.
 *
 * `checkedAt` is a client stand-in for the server's stamp — the row only reads
 * it as a boolean and as an input to the TTL, and the real value arrives with
 * the invalidate a moment later.
 *
 * It is the LATER of the browser's clock and the payload's `readAt`, not simply
 * `Date.now()`. A browser running behind the server would otherwise stamp a row
 * before the visibility cutoff {@link visibleItems} computes from `readAt`, and
 * the row the shopper just tapped would disappear instead of dimming — the exact
 * failure D10 exists to prevent, on the exact machines least likely to have a
 * correct clock.
 */
export function withItemChecked(list: GroceryListPayload, itemId: string, checked: boolean, checkedByHandle: string | null = null): GroceryListPayload {
  const readAt = Date.parse(list.readAt);
  const stamp = new Date(Math.max(Date.now(), Number.isFinite(readAt) ? readAt : 0)).toISOString();
  return withItemPatched(list, itemId, (item) => ({
    ...item,
    checkedAt: checked ? stamp : null,
    checkedByHandle: checked ? checkedByHandle : null,
  }));
}

/** Drop a row outright — "I did not want this", not "I bought it". */
export function withItemRemoved(list: GroceryListPayload, itemId: string): GroceryListPayload {
  if (!list.items.some((item) => item.id === itemId)) return list;
  return { ...list, items: list.items.filter((item) => item.id !== itemId) };
}

/**
 * Apply an inline edit. `quantity` arrives in BASE units (run a typed number
 * through {@link baseQuantity} first) and the rendered total is recomputed here
 * so the row never shows a stale `1 lb 8 oz` beside a freshly typed `2`.
 *
 * A blank display name is ignored rather than saved: the server's validator
 * rejects it too, and a row with no name is unreadable in a store.
 */
export function withItemEdited(list: GroceryListPayload, itemId: string, patch: { displayName?: string; quantity?: number | null }): GroceryListPayload {
  return withItemPatched(list, itemId, (item) => {
    const displayName = patch.displayName?.trim();
    const next: GroceryItemRow = {
      ...item,
      displayName: displayName ? displayName : item.displayName,
      quantity: patch.quantity !== undefined ? patch.quantity : item.quantity,
    };
    return { ...next, quantityDisplay: renderRowQuantity(next) };
  });
}

/** The end-of-trip sweep: everything checked leaves at once. */
export function withCheckedCleared(list: GroceryListPayload): GroceryListPayload {
  if (!list.items.some((item) => item.checkedAt)) return list;
  return { ...list, items: list.items.filter((item) => !item.checkedAt) };
}

/** The other sweep: the whole list goes, checked or not. */
export function withAllCleared(list: GroceryListPayload): GroceryListPayload {
  if (list.items.length === 0) return list;
  return { ...list, items: [] };
}
