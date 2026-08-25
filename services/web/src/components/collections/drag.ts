/**
 * The two drags the collections feature runs, and the typed payloads that keep
 * them apart (plan §7).
 *
 * There are exactly two, they overlap on screen, and they must never cross-drop:
 *
 * - **`RECIPE_DRAG_TYPE`** — a recipe, dragged by the grip on a ledger row. It
 *   can land on a collection row (file it there) or, when the ledger is scoped to
 *   a collection with an empty search box, in the gap between two ledger rows
 *   (reorder the entry order, which IS the published `recipes` array order).
 * - **`COLLECTION_DRAG_TYPE`** — a collection row, dragged inside the tree, and
 *   good for one thing only: the household's local list order (§2.10, never
 *   published).
 *
 * A custom MIME type is what makes that structural rather than hopeful. A drop
 * target reads `dataTransfer.types` in `dragover` — the one moment `getData` is
 * deliberately blank — and refuses to `preventDefault()` for a type it does not
 * accept, so the browser paints "no drop" over a collection dragged onto a
 * ledger, and a file, a text selection or a link dragged in from anywhere else
 * is inert over both. The `x-buttery-` prefix keeps them ours: nothing outside
 * the app produces either type, so a drag from another tab cannot masquerade as
 * one.
 */

/** A recipe id, dragged from a ledger row. */
export const RECIPE_DRAG_TYPE = "application/x-buttery-recipe";

/** A collection id, dragged from a tree row. Tree-internal, list order only. */
export const COLLECTION_DRAG_TYPE = "application/x-buttery-collection";

/**
 * Whether a drag in flight is carrying `type`.
 *
 * `dataTransfer.types` is the only part of the payload readable during
 * `dragover`, which is exactly when a target has to decide whether it is a
 * target at all.
 */
export function dragCarries(dataTransfer: DataTransfer, type: string): boolean {
  return dataTransfer.types.includes(type);
}
