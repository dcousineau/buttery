import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { BookOpenText, EyeOff, Star, UtensilsCrossed } from "lucide-react";
import type { HouseholdRecipeRow } from "#/server/household-recipes";
import { Button } from "#/components/ui/button";
import { Select } from "#/components/ui/select";
import { cn } from "#/lib/utils";
import { SourceIcon } from "./SourceIcon";

export type SortKey = "recent" | "time" | "title";

export interface LedgerFilters {
  q: string;
  tag: string;
  sort: SortKey;
}

/** Filter/sort/search the box client-side (plan §5.2). Original array order is
 * `added_at desc`, so "Recent" is the identity sort. */
function filterAndSort(recipes: HouseholdRecipeRow[], { q, tag, sort }: LedgerFilters): HouseholdRecipeRow[] {
  const needle = q.trim().toLowerCase();
  let list = recipes.filter((r) => {
    if (tag !== "All" && !r.keywords.includes(tag)) return false;
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

/**
 * The tag chips. The handoff assumes a small curated keyword vocabulary; real
 * synced recipes carry long, noisy keyword lists (one recipe alone can have 25+),
 * so we surface the most SHARED facets: distinct keywords ranked by how many
 * recipes carry them (tie-broken by first-seen order), capped so the filter bar
 * stays compact. A single-recipe keyword is a poor filter anyway.
 */
const MAX_TAGS = 18;
function topTags(recipes: HouseholdRecipeRow[]): string[] {
  const count = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let ord = 0;
  for (const r of recipes) {
    for (const k of new Set(r.keywords)) {
      count.set(k, (count.get(k) ?? 0) + 1);
      if (!firstSeen.has(k)) firstSeen.set(k, ord++);
    }
  }
  return [...count.keys()].sort((a, b) => count.get(b)! - count.get(a)! || firstSeen.get(a)! - firstSeen.get(b)!).slice(0, MAX_TAGS);
}

export function RecipeLedger({
  recipes,
  selectedId,
  filters,
  onFiltersChange,
  onOpenPicker,
  className,
}: {
  recipes: HouseholdRecipeRow[];
  selectedId: string | null;
  filters: LedgerFilters;
  onFiltersChange: (f: LedgerFilters) => void;
  onOpenPicker: () => void;
  className?: string;
}) {
  const tags = useMemo(() => {
    const top = topTags(recipes);
    // Keep an active non-"All" tag visible even if it falls outside the top set.
    return filters.tag !== "All" && !top.includes(filters.tag) ? [filters.tag, ...top] : top;
  }, [recipes, filters.tag]);
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
          <Button size="sm" className="h-[30px]" onClick={onOpenPicker}>
            Add
          </Button>
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {["All", ...tags].map((t) => {
              const active = filters.tag === t;
              return (
                <button
                  key={t}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onFiltersChange({ ...filters, tag: active && t !== "All" ? "All" : t })}
                  className={cn(
                    "h-[22px] cursor-(--cursor-interactive) rounded-4xl border-2 border-border px-2.5 text-[0.6875rem] font-semibold transition-colors",
                    active ? "bg-primary text-primary-foreground" : "bg-background text-foreground hover:bg-accent",
                  )}
                >
                  {t}
                </button>
              );
            })}
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
          <EmptyBox onOpenPicker={onOpenPicker} />
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

function LedgerRow({ row, selected }: { row: HouseholdRecipeRow; selected: boolean }) {
  return (
    <li className="border-b-2 border-border/45">
      <Link
        to="/household/recipes/$id"
        params={{ id: row.recipeId }}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-2.5 px-2.5 py-[7px] no-underline outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:-ring-offset-2",
          selected ? "bg-accent" : "hover:bg-accent/40",
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

function EmptyBox({ onOpenPicker }: { onOpenPicker: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <UtensilsCrossed className="size-8 text-muted-foreground" aria-hidden="true" />
      <div>
        <p className="m-0 text-[0.8125rem] font-bold text-foreground">Your shelf is empty</p>
        <p className="mt-1 mb-0 text-xs text-muted-foreground">Add a recipe from the public collection to start your household's box.</p>
      </div>
      <Button size="sm" onClick={onOpenPicker}>
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
      <p className="m-0 text-xs text-muted-foreground">Clear the tag filter to see the whole household's shelf again.</p>
    </div>
  );
}
