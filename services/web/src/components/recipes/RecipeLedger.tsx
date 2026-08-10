import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { BookOpenText, EyeOff, Lock, Plus, Star, UtensilsCrossed } from "lucide-react";
import type { HouseholdRecipeRow } from "#/server/household-recipes";
import { Button } from "#/components/ui/button";
import { Select } from "#/components/ui/select";
import { selectableRowVariants } from "#/components/ui/selectable-row";
import { cn } from "#/lib/utils";
import { SourceIcon } from "./SourceIcon";

export type SortKey = "recent" | "time" | "title";

export interface LedgerFilters {
  q: string;
  sort: SortKey;
  /** Show only the household's private/unpublished recipes ("My recipes"). */
  mine: boolean;
}

/** Filter/sort/search the box client-side (plan §5.2). Original array order is
 * `added_at desc`, so "Recent" is the identity sort. */
function filterAndSort(recipes: HouseholdRecipeRow[], { q, sort, mine }: LedgerFilters): HouseholdRecipeRow[] {
  const needle = q.trim().toLowerCase();
  let list = recipes.filter((r) => {
    if (mine && !r.unpublished) return false;
    if (!needle) return true;
    const hay = [r.title, r.sourceLabel, ...r.keywords].join(" ").toLowerCase();
    return hay.includes(needle);
  });
  if (sort === "title") {
    list = [...list].sort((a, b) => a.title.localeCompare(b.title));
  } else if (sort === "time") {
    list = [...list].sort((a, b) => {
      if (a.totalMinutes == null) return 1;
      if (b.totalMinutes == null) return -1;
      return a.totalMinutes - b.totalMinutes;
    });
  }
  return list;
}

export function RecipeLedger({
  recipes,
  selectedId,
  filters,
  onFiltersChange,
  onAdd,
  className,
}: {
  recipes: HouseholdRecipeRow[];
  selectedId: string | null;
  filters: LedgerFilters;
  onFiltersChange: (f: LedgerFilters) => void;
  onAdd: () => void;
  className?: string;
}) {
  const mineCount = useMemo(() => recipes.filter((r) => r.unpublished).length, [recipes]);
  const visible = useMemo(() => filterAndSort(recipes, filters), [recipes, filters]);
  const boxEmpty = recipes.length === 0;

  return (
    <div className={cn("flex min-h-0 flex-col border-border bg-background lg:w-[360px] lg:shrink-0 lg:border-r-2", className)}>
      {/* Filter bar — deliberately compact, not a card. */}
      <div className="flex flex-none flex-col gap-1.5 border-b-2 border-border bg-card px-2.5 py-2">
        <div className="flex gap-1.5">
          <div className="flex h-[30px] flex-1 items-center gap-1.5 rounded-lg border-2 border-border bg-background px-2.5">
            <BookOpenText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              type="search"
              value={filters.q}
              onChange={(e) => onFiltersChange({ ...filters, q: e.target.value })}
              placeholder={`Search ${recipes.length} recipe${recipes.length === 1 ? "" : "s"}`}
              aria-label="Search recipes"
              className="min-w-0 flex-1 border-0 bg-transparent text-[0.8125rem] font-medium text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
            />
          </div>
          <Select
            size="sm"
            aria-label="Sort recipes"
            value={filters.sort}
            onChange={(e) => onFiltersChange({ ...filters, sort: e.target.value as SortKey })}
            className="h-[30px] w-auto text-xs font-semibold"
          >
            <option value="recent">Recent</option>
            <option value="time">Quickest</option>
            <option value="title">A–Z</option>
          </Select>
          <Button size="sm" className="h-[30px]" onClick={onAdd}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            Add
          </Button>
        </div>
        {!boxEmpty && (
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              aria-pressed={filters.mine}
              onClick={() => onFiltersChange({ ...filters, mine: !filters.mine })}
              className={cn(
                "inline-flex h-[22px] items-center gap-1 cursor-(--cursor-interactive) rounded-4xl border-2 border-border px-2.5 text-[0.6875rem] font-semibold transition-colors",
                filters.mine ? "bg-primary text-primary-foreground" : "bg-background text-foreground hover:bg-accent",
              )}
            >
              <Lock className="size-[11px]" aria-hidden="true" />
              My recipes
              {mineCount > 0 && <span className="opacity-70">· {mineCount}</span>}
            </button>
          </div>
        )}
      </div>

      {/* Filter results are a status message — announce the count as the search /
       * tag narrows the list, so non-sighted users hear it change. */}
      <div className="sr-only" role="status" aria-live="polite">
        {boxEmpty ? "" : visible.length === 0 ? "No recipes match your filters." : `${visible.length} recipe${visible.length === 1 ? "" : "s"}.`}
      </div>

      {/* List */}
      <div className="min-h-0 flex-1 overflow-auto">
        {boxEmpty ? (
          <EmptyBox onAdd={onAdd} />
        ) : visible.length === 0 ? (
          <EmptyFilter />
        ) : (
          <ul className="m-0 list-none p-0">
            {visible.map((r) => (
              <LedgerRow key={r.recipeId} row={r} selected={r.recipeId === selectedId} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The two `Add` affordances (filter bar + empty box) open the chooser modal. */

function LedgerRow({ row, selected }: { row: HouseholdRecipeRow; selected: boolean }) {
  return (
    <li className="border-b-2 border-border/45">
      <Link
        to="/household/recipes/$id"
        params={{ id: row.recipeId }}
        // The row *is* a link to the current page when it's the selected one, so "page"
        // rather than a bare "true" — same state the butter marker paints.
        aria-current={selected ? "page" : undefined}
        // Focus is an outline drawn INSIDE the row, the same way the import list's rows do
        // it. An outward ring is invisible here: rows are flush edge-to-edge in an
        // `overflow-auto` pane, so the sides get clipped by the scrollport and the top and
        // bottom get painted over by the neighbouring rows' dividers. (The `ring-3` +
        // `-ring-offset-2` this replaces produced exactly that — a hairline at the bottom
        // edge and nothing else.) Kept deliberately unlike the butter selection marker:
        // focus and selection sit on different rows while arrowing through the box.
        className={cn(
          "grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-2.5 px-2.5 py-[7px] no-underline focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-ring",
          selectableRowVariants({ selected }),
        )}
      >
        {row.thumbUrl ? (
          <img src={row.thumbUrl} alt="" className="size-11 rounded-sm border-2 border-border object-cover" loading="lazy" />
        ) : (
          <div className="grid size-11 place-content-center rounded-sm border-2 border-border bg-muted">
            <UtensilsCrossed className="size-4 text-muted-foreground" aria-hidden="true" />
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-1 truncate text-[0.8125rem] font-bold leading-tight text-foreground">
            <span className="truncate">{row.title}</span>
            {row.unpublished && <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Private — not published" />}
            {row.favorite && <Star className="size-3 shrink-0 fill-primary text-primary" aria-label="Favorited" />}
            {row.unavailable && <EyeOff className="size-3 shrink-0 text-muted-foreground" aria-label="Source no longer available" />}
          </div>
          <div className="flex items-center gap-1 truncate text-[0.6875rem] font-semibold text-muted-foreground">
            <SourceIcon kind={row.sourceKind} className="size-[11px] shrink-0" />
            <span className="truncate">{row.sourceLabel}</span>
          </div>
          {row.keywords.length > 0 && <div className="truncate text-[0.6875rem] text-muted-foreground">{row.keywords.join(" · ")}</div>}
        </div>
        {row.totalTimeDisplay && <div className="text-[0.6875rem] font-bold whitespace-nowrap text-muted-foreground">{row.totalTimeDisplay}</div>}
      </Link>
    </li>
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
      <p className="m-0 text-xs text-muted-foreground">Clear the search or the "My recipes" filter to see the whole shelf again.</p>
    </div>
  );
}
