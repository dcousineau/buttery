import type { GroceryItemRow } from "#/server/grocery";
import { AisleGroup } from "./AisleGroup";
import { GroceryEmptyState } from "./GroceryEmptyState";
import { GroceryRow } from "./GroceryRow";
import { groupByAisle, listCounts } from "./optimistic";

/**
 * The list body: either one section per aisle (the default) or one flat run of
 * rows when `?group=flat` is on.
 *
 * The flat mode is plan D8's escape hatch, and it is the only correction the
 * feature offers — there is no per-row aisle override, so when the lexicon puts
 * something in the wrong aisle the answer is to stop grouping rather than to
 * argue with it. Flat order is the list's own insertion order, which is what the
 * server returns inside an aisle anyway.
 *
 * Rows arrive already filtered for the D10 TTL by the route; this component does
 * no filtering of its own so there is exactly one place that decides what is
 * visible.
 */

export interface GroceryListProps {
  items: GroceryItemRow[];
  /** False ⇒ `?group=flat` — one run of rows, no aisle headings. */
  grouped: boolean;
  onToggle: (item: GroceryItemRow, checked: boolean) => void;
  onEdit: (item: GroceryItemRow, patch: { displayName?: string; quantity?: number | null }) => void;
  onRemove: (item: GroceryItemRow) => void;
}

export function GroceryList({ items, grouped, onToggle, onEdit, onRemove }: GroceryListProps) {
  if (items.length === 0) return <GroceryEmptyState />;

  const { remaining } = listCounts(items);
  // Everything checked is not an empty list — the rows stay on screen (D10), so
  // the note goes UNDER them rather than replacing them.
  const allDone = remaining === 0;

  if (!grouped) {
    return (
      <div className="flex flex-col gap-3">
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {items.map((item) => (
            <GroceryRow key={item.id} item={item} onToggle={(checked) => onToggle(item, checked)} onEdit={(patch) => onEdit(item, patch)} onRemove={() => onRemove(item)} />
          ))}
        </ul>
        {allDone && <GroceryEmptyState variant="cleared" className="py-6" />}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {groupByAisle(items).map((section) => (
        <AisleGroup key={section.aisle} aisle={section.aisle} label={section.label} items={section.items} onToggle={onToggle} onEdit={onEdit} onRemove={onRemove} />
      ))}
      {allDone && <GroceryEmptyState variant="cleared" className="py-6" />}
    </div>
  );
}
