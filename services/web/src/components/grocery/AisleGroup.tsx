import { useId } from "react";
import type { GroceryItemRow } from "#/lib/api";
import type { Aisle } from "@buttery/food/aisles";
import { GroceryRow } from "./GroceryRow";
import { listCounts } from "./optimistic";

/**
 * One aisle's section of the list (plan D7).
 *
 * The heading is sticky inside the scroll container because the whole point of
 * grouping is knowing which aisle you are shopping without scrolling back up —
 * on a phone, three rows down is already enough to lose it.
 *
 * Only aisles that have rows are rendered; the caller (`GroceryList`) does that
 * filtering through `groupByAisle`, so an empty `Deli` never takes up a line in
 * a store.
 */

export interface AisleGroupProps {
  aisle: Aisle;
  label: string;
  items: GroceryItemRow[];
  onToggle: (item: GroceryItemRow, checked: boolean) => void;
  onEdit: (item: GroceryItemRow, patch: { displayName?: string; quantity?: number | null }) => void;
  onRemove: (item: GroceryItemRow) => void;
  /** Threaded from the route: false while offline (§4.1). */
  writable?: boolean;
}

export function AisleGroup({ aisle, label, items, onToggle, onEdit, onRemove, writable }: AisleGroupProps) {
  const headingId = useId();
  const { remaining } = listCounts(items);

  return (
    <section aria-labelledby={headingId} data-aisle={aisle} className="flex flex-col">
      <h2
        id={headingId}
        className="sticky top-0 z-10 flex items-baseline gap-2 bg-background px-3 pt-3 pb-1.5 text-xs font-bold tracking-[0.08em] text-muted-foreground uppercase md:px-4"
      >
        {label}
        {/* The count is what makes a sticky heading worth its pixels: "3 left"
          answers "am I done with this aisle?" without reading the rows. */}
        <span className="text-[0.6875rem] font-semibold tracking-normal normal-case">{remaining === 0 ? "all in the cart" : `${remaining} left`}</span>
      </h2>
      {/* No gap: the rows are slats, so the divider is what separates them. */}
      <ul className="m-0 flex list-none flex-col p-0">
        {items.map((item) => (
          <GroceryRow
            key={item.id}
            item={item}
            onToggle={(checked) => onToggle(item, checked)}
            onEdit={(patch) => onEdit(item, patch)}
            onRemove={() => onRemove(item)}
            writable={writable}
          />
        ))}
      </ul>
    </section>
  );
}
