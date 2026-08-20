import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { BookOpenText, Clock, Lock, Star } from "lucide-react";
import { createCollection, householdCollectionsQuery, householdRecipesQuery, keys } from "#/lib/api";
import { OFFLINE_WRITE_HINT, useIsOnline } from "#/lib/offline/use-online";
import { useRecipesView } from "#/components/recipes/context";
import { cn } from "#/lib/utils";
import { CollectionRow, CollectionTreeRow } from "./CollectionRow";
import { EditCollectionDialog } from "./EditCollectionDialog";
import { QuickAddRow } from "./QuickAddRow";
import { DEFAULT_SCOPE, resolveScope, SMART_SCOPE_LABELS, SMART_SCOPES, type SmartScope, smartScopeCount } from "./scope";

/**
 * The collections tree: four smart rows, the household's collections, and the
 * inline quick-add — collections plan §7.
 *
 * **This component is the whole feature's navigation, and it takes almost no
 * props on purpose.** It reads the two cached queries itself and writes its
 * selection to the URL, so mounting it is the entire integration: the desktop
 * column wraps it in an `<aside>`, and milestone 4's `CollectionsSheet` wraps it
 * in a `Sheet` and passes `onNavigate` to close the sheet behind a tap. Neither
 * wrapper has to know what a scope is, and milestone 4 must not have to edit
 * this file.
 *
 * Both reads are `useSuspenseQuery` against entries the layout route's loader
 * has already primed — so this suspends only in the pathological case, and gets
 * refetch-on-reconnect and prefix invalidation for free (offline plan §4.1).
 *
 * The **smart rows replace the ledger's sort dropdown and its old "My recipes"
 * lock-chip** (§2.2). That chip was an unpublished-only filter wearing the wrong
 * name; "Unpublished" here is the same filter, honestly labelled.
 */

const SMART_ICONS: Record<SmartScope, typeof BookOpenText> = {
  mine: BookOpenText,
  recent: Clock,
  favorites: Star,
  unpublished: Lock,
};

export function CollectionsTree({ householdId, onNavigate, className }: { householdId: string; onNavigate?: () => void; className?: string }) {
  const { data: recipes } = useSuspenseQuery(householdRecipesQuery(householdId));
  const { data: collections } = useSuspenseQuery(householdCollectionsQuery(householdId));
  const search = useSearch({ from: "/household/recipes" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const online = useIsOnline();
  const { pushToast } = useRecipesView();

  /**
   * Which collection the edit dialog is on — an **id**, resolved back to the
   * live summary below rather than held as a snapshot. A snapshot would freeze
   * the dialog's member list at the moment it opened, so unfiling a recipe from
   * inside the dialog moved the tree's count and left the list it was removed
   * from still showing it.
   */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const scope = resolveScope(search, collections);
  // Gone from the list (deleted by another member) closes the dialog by itself.
  const editing = collections.find((collection) => collection.id === editingId) ?? null;

  /**
   * Create is **not** optimistic (§6): the server mints the ULID and the
   * position, so there is nothing truthful to render until it answers. It does
   * return the finished summary, though, which is why quick-add can select the
   * new collection on the same tick rather than waiting for the invalidation to
   * land.
   */
  async function onCreate(name: string) {
    setCreating(true);
    try {
      const created = await createCollection({ name });
      await queryClient.invalidateQueries({ queryKey: keys.household.collections(householdId) });
      await navigate({ to: "/household/recipes", search: { c: created.id } });
      onNavigate?.();
    } catch {
      pushToast("That collection didn't save. Try again.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      {/* Matches the ledger's filter-bar box exactly (same padding, same 30px
        control row) so the two column heads line up across the divider. */}
      <div className="flex flex-none items-center border-b-2 border-border bg-card px-2.5 py-2">
        <h2 className="m-0 flex h-[30px] items-center text-[0.6875rem] font-bold tracking-[0.06em] text-muted-foreground uppercase">Collections</h2>
      </div>

      <nav aria-label="Recipe collections" className="min-h-0 flex-1 overflow-auto py-1">
        <ul className="m-0 list-none p-0">
          {SMART_SCOPES.map((smart) => (
            <CollectionTreeRow
              key={smart}
              icon={SMART_ICONS[smart]}
              label={SMART_SCOPE_LABELS[smart]}
              count={smartScopeCount(recipes, smart)}
              active={scope.kind === "smart" && scope.scope === smart}
              // The landing scope is spelled by leaving the param out, so the
              // default view has one URL rather than two.
              search={{ scope: smart === DEFAULT_SCOPE ? undefined : smart }}
              onNavigate={onNavigate}
            />
          ))}
        </ul>

        <h3 className="m-0 px-2.5 pt-3 pb-1 text-[0.6875rem] font-bold tracking-[0.06em] text-muted-foreground uppercase">Your shelves</h3>

        {collections.length === 0 ? (
          <p className="m-0 px-2.5 pb-1 text-xs text-pretty text-muted-foreground">Nothing here yet. A shelf is just a name and the recipes you file on it.</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {collections.map((collection) => (
              <CollectionRow
                key={collection.id}
                collection={collection}
                active={scope.kind === "collection" && scope.collection.id === collection.id}
                onNavigate={onNavigate}
                onEdit={(target) => setEditingId(target.id)}
              />
            ))}
          </ul>
        )}

        {/* Writes are online-only (§6), so the row disables rather than queuing
          a create whose id the client could not predict anyway. */}
        <QuickAddRow onCreate={onCreate} pending={creating} disabled={!online || creating} disabledHint={online ? undefined : OFFLINE_WRITE_HINT} />
      </nav>

      <EditCollectionDialog
        householdId={householdId}
        collection={editing}
        recipes={recipes}
        onOpenChange={(open) => {
          if (!open) setEditingId(null);
        }}
      />
    </div>
  );
}
