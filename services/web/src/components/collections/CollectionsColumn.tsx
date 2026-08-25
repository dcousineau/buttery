import { cn } from "#/lib/utils";
import { CollectionsTree } from "./CollectionsTree";

/**
 * The desktop third column (§7) — the collections tree, docked to the left of
 * the recipe ledger inside the recipes page.
 *
 * Two responsive rules, and both are borrowed rather than invented:
 *
 * - **`hidden md:flex`.** Below `md` the page has room for one column, and that
 *   column is the ledger; the tree gets a Sheet instead (milestone 4).
 * - **It yields to the detail pane exactly like the ledger does.** Between `md`
 *   and `lg` the ledger already collapses when a recipe is selected
 *   (`hidden lg:flex`), because two columns do not fit; a third column that
 *   stayed would push the ledger off screen and leave the page showing a tree
 *   and a recipe with nothing between them.
 *
 * Collapsed state is `open`, owned by the route and persisted in a cookie
 * (`use-collections-column.ts`), and collapsing renders `display: none` rather
 * than unmounting: the tree's two queries are already observed by the route, the
 * markup is small, and a hidden subtree keeps its links out of the tab order for
 * free. The toggle lives in the ledger's filter bar and points here with
 * `aria-controls`.
 */
export function CollectionsColumn({ id, householdId, open, hasSelection }: { id: string; householdId: string; open: boolean; hasSelection: boolean }) {
  return (
    <aside
      id={id}
      className={cn("min-h-0 w-[232px] shrink-0 flex-col border-r-2 border-border bg-background", !open ? "hidden" : hasSelection ? "hidden lg:flex" : "hidden md:flex")}
    >
      <CollectionsTree householdId={householdId} />
    </aside>
  );
}
