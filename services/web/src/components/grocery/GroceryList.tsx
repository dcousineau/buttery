import type { GroceryItemRow } from "#/lib/api";
import { AisleGroup } from "./AisleGroup";
import { GroceryEmptyState } from "./GroceryEmptyState";
import { groupByAisle, listCounts } from "./optimistic";

/**
 * The list body: one section per aisle, always.
 *
 * Grouping is unconditional — there is no flat mode and no per-row aisle
 * override, so a miscategorised line is corrected by renaming it, not by
 * abandoning the layout. Order inside an aisle is the list's own insertion
 * order, which is what the server returns anyway.
 *
 * Rows arrive already filtered for the D10 TTL by the route; this component does
 * no filtering of its own so there is exactly one place that decides what is
 * visible.
 */

export interface GroceryListProps {
  items: GroceryItemRow[];
  onToggle: (item: GroceryItemRow, checked: boolean) => void;
  onEdit: (item: GroceryItemRow, patch: { displayName?: string; quantity?: number | null }) => void;
  onRemove: (item: GroceryItemRow) => void;
  /** Threaded from the route: false while offline (§4.1). */
  writable?: boolean;
}

export function GroceryList({ items, onToggle, onEdit, onRemove, writable }: GroceryListProps) {
  if (items.length === 0) return <GroceryEmptyState />;

  const { remaining } = listCounts(items);
  // Everything checked is not an empty list — the rows stay on screen (D10), so
  // the note goes UNDER them rather than replacing them.
  const allDone = remaining === 0;

  return (
    <div className="flex flex-col">
      {groupByAisle(items).map((section) => (
        <AisleGroup
          key={section.aisle}
          aisle={section.aisle}
          label={section.label}
          items={section.items}
          onToggle={onToggle}
          onEdit={onEdit}
          onRemove={onRemove}
          writable={writable}
        />
      ))}
      {allDone && <GroceryEmptyState variant="cleared" className="py-6" />}
    </div>
  );
}
