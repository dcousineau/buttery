import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { BookOpenText, EyeOff, FolderLock, Lock, Plus, Star, UtensilsCrossed } from "lucide-react";
import type { HouseholdRecipeRow } from "#/lib/api";
import { Button } from "#/components/ui/button";
import { ScopedLedgerHeader } from "#/components/collections/ScopedLedgerHeader";
import { isDefaultScope, type LedgerScope, scopeLabel, scopeRows, searchRows } from "#/components/collections/scope";
import { cn } from "#/lib/utils";
import { RecipeSlat, RecipeSlatAction, RecipeSlatAside, RecipeSlatBody, RecipeSlatDetail, RecipeSlatList, RecipeSlatMeta, RecipeSlatTitle } from "./RecipeSlat";
import { SourceIcon } from "./SourceIcon";

/**
 * The recipe box ledger — now a **scoped** ledger (collections plan §7).
 *
 * What used to live in this file and no longer does: a `sort` dropdown and a "My
 * recipes" lock-chip. Both were subsumed by the collections tree's smart rows
 * (§2.2) — the chip was an unpublished-only filter under a misleading name, and
 * the sort was three options where the tree now offers four scopes plus every
 * collection the household has made. Sorting *within* a scope is deliberately
 * deferred (§2.2): a collection's order is manual and is the published array
 * order, so a sort control over it would have to mean "look, don't touch", and
 * that is a bigger conversation than a `<select>`.
 *
 * The ledger does not resolve its own scope. The layout route reads the URL and
 * hands the resolved `LedgerScope` down, because the same two search params also
 * drive the tree's highlight, and one resolver means the two columns cannot
 * disagree about what is selected.
 *
 * Search stays **local component state, owned by the route** and narrows *within*
 * the active scope — it is a lens, not a place, so it does not belong in the URL
 * beside the scope that is.
 */

/** The ordered, searched rows for the active scope. */
function visibleRows(recipes: HouseholdRecipeRow[], scope: LedgerScope, query: string): HouseholdRecipeRow[] {
  return searchRows(scopeRows(recipes, scope), query);
}

export function RecipeLedger({
  recipes,
  scope,
  selectedId,
  query,
  onQueryChange,
  onAdd,
  collectionsOpen,
  onToggleCollections,
  collectionsPanelId,
  className,
}: {
  recipes: HouseholdRecipeRow[];
  /** Resolved by the layout route from `?scope=` / `?c=`. */
  scope: LedgerScope;
  selectedId: string | null;
  query: string;
  onQueryChange: (q: string) => void;
  onAdd: () => void;
  collectionsOpen: boolean;
  onToggleCollections: () => void;
  /** The collections column's DOM id, for the toggle's `aria-controls`. */
  collectionsPanelId: string;
  className?: string;
}) {
  const visible = useMemo(() => visibleRows(recipes, scope, query), [recipes, scope, query]);
  const boxEmpty = recipes.length === 0;
  const missing = scope.kind === "missing-collection";
  const emptyShelf = scope.kind === "collection" && scope.collection.recipeIds.length === 0;

  return (
    <div className={cn("flex min-h-0 flex-col border-border bg-background lg:w-[360px] lg:shrink-0 lg:border-r-2", className)}>
      {/* Filter bar — deliberately compact, not a card. */}
      <div className="flex flex-none gap-1.5 border-b-2 border-border bg-card px-2.5 py-2">
        {/* The collections column's only toggle. It lives here rather than on the
          column itself because a collapsed column has nowhere to put a control. */}
        <Button
          variant="outline"
          size="sm"
          className="h-[30px] max-md:hidden"
          aria-expanded={collectionsOpen}
          aria-controls={collectionsPanelId}
          aria-label={collectionsOpen ? "Hide collections" : "Show collections"}
          onClick={onToggleCollections}
        >
          <FolderLock aria-hidden="true" />
        </Button>
        <div className="flex h-[30px] flex-1 items-center gap-1.5 rounded-lg border-2 border-border bg-background px-2.5">
          <BookOpenText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            // A scope that resolved to nothing has no name worth searching, so
            // the placeholder falls back to the box rather than saying "Search
            // Collection not found".
            placeholder={isDefaultScope(scope) || missing ? `Search ${recipes.length} recipe${recipes.length === 1 ? "" : "s"}` : `Search ${scopeLabel(scope)}`}
            aria-label="Search recipes"
            className="min-w-0 flex-1 border-0 bg-transparent text-[0.8125rem] font-medium text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
        <Button size="sm" className="h-[30px]" onClick={onAdd}>
          <Plus data-icon="inline-start" aria-hidden="true" />
          Add
        </Button>
      </div>

      {!isDefaultScope(scope) && <ScopedLedgerHeader scope={scope} count={visible.length} />}

      {/* Filter results are a status message — announce the count as the search /
       * scope narrows the list, so non-sighted users hear it change. */}
      <div className="sr-only" role="status" aria-live="polite">
        {boxEmpty
          ? ""
          : missing
            ? "This collection no longer exists."
            : visible.length === 0
              ? emptyShelf && !query
                ? `${scopeLabel(scope)} is empty.`
                : "No recipes match your filters."
              : `${visible.length} recipe${visible.length === 1 ? "" : "s"}.`}
      </div>

      {/* List */}
      <div className="min-h-0 flex-1 overflow-auto">
        {boxEmpty ? (
          <EmptyBox onAdd={onAdd} />
        ) : missing ? (
          <MissingCollection />
        ) : visible.length === 0 ? (
          emptyShelf && !query ? (
            <EmptyShelf name={scopeLabel(scope)} />
          ) : (
            <EmptyFilter />
          )
        ) : (
          // TODO(m3): when `scope.kind === "collection"` and the search box is
          // empty, each row gains a drag handle and the list gains a `DropLine`
          // (the `LineEditor` pattern) so the entry order — which IS the
          // published `recipes` array order — is draggable.
          <RecipeSlatList>
            {visible.map((r) => (
              <LedgerRow key={r.recipeId} row={r} selected={r.recipeId === selectedId} />
            ))}
          </RecipeSlatList>
        )}
      </div>
    </div>
  );
}

/** The two `Add` affordances (filter bar + empty box) open the chooser modal. */

function LedgerRow({ row, selected }: { row: HouseholdRecipeRow; selected: boolean }) {
  return (
    <RecipeSlat selected={selected}>
      <RecipeSlatAction
        // `search: (prev) => prev` carries the active scope onto the detail
        // route (§7): opening a recipe from inside "Weeknights" keeps you inside
        // Weeknights, and the resulting URL deep-links to both at once.
        render={<Link to="/household/recipes/$id" params={{ id: row.recipeId }} search={(prev) => prev} />}
        // The row *is* a link to the current page when it's the selected one, so "page"
        // rather than a bare "true" — same state the butter marker paints.
        aria-current={selected ? "page" : undefined}
      >
        {row.thumbUrl ? (
          <img src={row.thumbUrl} alt="" className="size-11 flex-none rounded-sm border-2 border-border object-cover" loading="lazy" />
        ) : (
          <span className="grid size-11 flex-none place-content-center rounded-sm border-2 border-border bg-muted">
            <UtensilsCrossed className="size-4 text-muted-foreground" aria-hidden="true" />
          </span>
        )}
        <RecipeSlatBody>
          <RecipeSlatTitle>
            <span className="truncate">{row.title}</span>
            {row.unpublished && <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Private — not published" />}
            {row.favorite && <Star className="size-3 shrink-0 fill-primary text-primary" aria-label="Favorited" />}
            {row.unavailable && <EyeOff className="size-3 shrink-0 text-muted-foreground" aria-label="Source no longer available" />}
          </RecipeSlatTitle>
          <RecipeSlatMeta className="flex items-center gap-1">
            <SourceIcon kind={row.sourceKind} className="size-[11px] shrink-0" />
            <span className="truncate">{row.sourceLabel}</span>
          </RecipeSlatMeta>
          {row.keywords.length > 0 && <RecipeSlatDetail>{row.keywords.join(" · ")}</RecipeSlatDetail>}
        </RecipeSlatBody>
        {row.totalTimeDisplay && <RecipeSlatAside>{row.totalTimeDisplay}</RecipeSlatAside>}
      </RecipeSlatAction>
    </RecipeSlat>
  );
}

function EmptyBox({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <UtensilsCrossed className="size-8 text-muted-foreground" aria-hidden="true" />
      <div>
        <p className="m-0 text-[0.8125rem] font-bold text-foreground">Your shelf is empty</p>
        <p className="mt-1 mb-0 text-xs text-muted-foreground">Write one out or bring one in from the web to start your household's box.</p>
      </div>
      <Button size="sm" onClick={onAdd}>
        Add a recipe
      </Button>
    </div>
  );
}

function EmptyFilter() {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-14 text-center">
      <UtensilsCrossed className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="m-0 text-[0.8125rem] font-bold text-foreground">Nothing matches that.</p>
      <p className="m-0 text-xs text-muted-foreground">Clear the search, or pick another collection, to see more of the shelf.</p>
    </div>
  );
}

/** A real, empty collection — a state to fill, not a search that found nothing. */
function EmptyShelf({ name }: { name: string }) {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-14 text-center">
      <FolderLock className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="m-0 text-[0.8125rem] font-bold text-foreground">{name} is empty</p>
      <p className="m-0 text-xs text-pretty text-muted-foreground">Open a recipe and file it here from its collections row.</p>
    </div>
  );
}

/**
 * `?c=` pointing at a collection that is not there any more — someone deleted it
 * while this tab held it, or the link outlived the shelf. An inline state, never
 * a 404 (§8): the box is fine, and one control gets you back to it.
 */
function MissingCollection() {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-14 text-center">
      <FolderLock className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="m-0 text-[0.8125rem] font-bold text-foreground">This collection no longer exists.</p>
      <p className="m-0 text-xs text-pretty text-muted-foreground">Someone in your household removed it. Your recipes are all still in the box.</p>
    </div>
  );
}
