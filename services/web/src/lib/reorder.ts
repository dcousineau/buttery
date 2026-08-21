/**
 * The arithmetic behind every manual order in the app — drag-to-reorder and the
 * keyboard path that has to mean exactly the same thing.
 *
 * All of it is pure and index-based, because that is the only part of a reorder
 * that can be tested at all (the repo has no DOM tests) and it is the part that
 * silently goes wrong: an insertion point read as a row index puts the row one
 * place too far whenever it travels downwards, and a list rendered as a *subset*
 * of the real order will happily write that subset back over the whole thing.
 *
 * Two vocabularies live here, and they are not interchangeable:
 *
 * - an **index** names an item (`0` is the first item);
 * - an **insertion point** names a gap *between* items, `0..list.length` — the
 *   thing a drop line is drawn in, and the only one of the two that can say
 *   "after the last row".
 */

/** What a keyboard press asks of the row the handle belongs to. */
export type ReorderMove = "up" | "down" | "top" | "bottom";

/** Move the item at `from` to index `to`, clamped. Returns the input when nothing moves. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return list;
  const target = Math.max(0, Math.min(to, list.length - 1));
  if (target === from) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

/**
 * Move the item at `from` into the gap `at`.
 *
 * Pulling the item out shifts everything below it up one, so an insertion point
 * past the item's old home is one too high once it is gone — the single
 * off-by-one every hand-written drag reorder gets wrong.
 */
export function moveToInsertionPoint<T>(list: T[], from: number, at: number): T[] {
  return moveItem(list, from, at > from ? at - 1 : at);
}

/** The keyboard equivalent of a drag: one step, or all the way to an end. */
export function moveByKey<T>(list: T[], from: number, move: ReorderMove): T[] {
  if (move === "top") return moveItem(list, from, 0);
  if (move === "bottom") return moveItem(list, from, list.length - 1);
  return moveItem(list, from, move === "up" ? from - 1 : from + 1);
}

/**
 * Fold an order made over a **rendered subset** back into the full order it came
 * from.
 *
 * The scoped ledger renders a collection's entries through the recipe box and
 * drops anything that is not boxed any more, so what someone drags is a
 * subsequence of `recipe_collection_entry` — and the reorder write replaces the
 * collection's *whole* order (and, once published, the record's `recipes` array).
 * Writing the rendered subset back would silently unfile every row that was not
 * on screen.
 *
 * So the hidden ids keep their absolute slots and the visible ones are dealt back
 * into the slots they already occupied, in their new sequence. Ids `nextVisible`
 * names that are not in `fullOrder` are ignored: a stale cache is not a licence to
 * invent an entry.
 */
export function applyVisibleOrder(fullOrder: string[], nextVisible: string[]): string[] {
  const present = new Set(fullOrder);
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const id of nextVisible) {
    if (!present.has(id) || seen.has(id)) continue;
    seen.add(id);
    queue.push(id);
  }
  let next = 0;
  return fullOrder.map((id) => (seen.has(id) ? (queue[next++] ?? id) : id));
}
