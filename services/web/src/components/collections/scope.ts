import type { CollectionSummary, HouseholdRecipeRow } from "#/lib/api";

/**
 * What the ledger is currently showing — the whole of collections plan §7's
 * "scope semantics", as pure functions over the two cached queries.
 *
 * **Nothing here fetches.** The box (`householdRecipesQuery`) and the collections
 * (`householdCollectionsQuery`) are both already in the cache by the time any
 * scope is resolved, and every view the feature offers is a rearrangement of
 * those two arrays. That is the single most load-bearing decision in the desktop
 * UI: switching scope is a client-side sort, so it costs no round trip, works
 * offline, and cannot show a spinner in the middle of a column someone is
 * scanning.
 *
 * The URL is the source of truth (`?scope=` / `?c=`), so this module is also the
 * one place that knows a collection id can point at nothing — a member deleted
 * the collection while a tab still had it open, or the link was shared after the
 * fact. That is a *state* (`missing-collection`), never a 404 (§8).
 */

/** The four smart rows, in the order the tree lists them. */
export const SMART_SCOPES = ["mine", "recent", "favorites", "unpublished"] as const;

export type SmartScope = (typeof SMART_SCOPES)[number];

/** The absent-`?scope=` default: the whole box, A–Z (§7). */
export const DEFAULT_SCOPE: SmartScope = "mine";

export const SMART_SCOPE_LABELS: Record<SmartScope, string> = {
  mine: "My recipes",
  recent: "Recently added",
  favorites: "Favorites",
  unpublished: "Unpublished",
};

/**
 * The resolved scope. `missing-collection` is deliberately its own arm rather
 * than a silent fall back to `mine`: the ledger owes the reader an explanation
 * for an empty list it did not ask for, and quietly showing the whole box would
 * look like the collection was fine and simply empty.
 */
export type LedgerScope = { kind: "smart"; scope: SmartScope } | { kind: "collection"; collection: CollectionSummary } | { kind: "missing-collection"; collectionId: string };

/** The layout route's search params, as far as scoping cares. */
export interface ScopeSearch {
  scope?: SmartScope;
  c?: string;
}

/** `?c=` wins over `?scope=` when both are present (§7). */
export function resolveScope(search: ScopeSearch, collections: CollectionSummary[]): LedgerScope {
  if (search.c != null && search.c !== "") {
    const collection = collections.find((entry) => entry.id === search.c);
    return collection ? { kind: "collection", collection } : { kind: "missing-collection", collectionId: search.c };
  }
  return { kind: "smart", scope: search.scope ?? DEFAULT_SCOPE };
}

/** True for the landing view — the one scope with nothing to clear. */
export function isDefaultScope(scope: LedgerScope): boolean {
  return scope.kind === "smart" && scope.scope === DEFAULT_SCOPE;
}

/** What the scoped-ledger header and the browser tab call this view. */
export function scopeLabel(scope: LedgerScope): string {
  if (scope.kind === "collection") return scope.collection.name;
  if (scope.kind === "missing-collection") return "Collection not found";
  return SMART_SCOPE_LABELS[scope.scope];
}

const byTitle = (a: HouseholdRecipeRow, b: HouseholdRecipeRow) => a.title.localeCompare(b.title);

/**
 * Rows for a smart scope. `recent` sorts explicitly rather than trusting the
 * server's `added_at desc` array order to stay that way — the sort is O(n log n)
 * on a household's box, which is a rounding error, and the alternative is a view
 * that silently degrades the day the read changes its `order by`.
 */
export function smartScopeRows(recipes: HouseholdRecipeRow[], scope: SmartScope): HouseholdRecipeRow[] {
  if (scope === "recent") return [...recipes].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  const list = scope === "favorites" ? recipes.filter((r) => r.favorite) : scope === "unpublished" ? recipes.filter((r) => r.unpublished) : recipes;
  return [...list].sort(byTitle);
}

/**
 * The rows the ledger renders, before the search box narrows them.
 *
 * A collection scope maps `recipeIds` (already in entry order — that IS the
 * published array order) through the box and drops anything that is no longer
 * boxed. Removing a recipe from the box unfiles it everywhere server-side
 * (§2.11), so a miss here is only ever a cache that has not caught up yet, and
 * rendering a hole would be worse than rendering nothing.
 */
export function scopeRows(recipes: HouseholdRecipeRow[], scope: LedgerScope): HouseholdRecipeRow[] {
  if (scope.kind === "missing-collection") return [];
  if (scope.kind === "collection") {
    const byId = new Map(recipes.map((row) => [row.recipeId, row]));
    const rows: HouseholdRecipeRow[] = [];
    for (const recipeId of scope.collection.recipeIds) {
      const row = byId.get(recipeId);
      if (row) rows.push(row);
    }
    return rows;
  }
  return smartScopeRows(recipes, scope.scope);
}

/** The search box, which narrows *within* the active scope and never across it. */
export function searchRows(rows: HouseholdRecipeRow[], query: string): HouseholdRecipeRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => [row.title, row.sourceLabel, ...row.keywords].join(" ").toLowerCase().includes(needle));
}

/** The count beside a smart row in the tree. */
export function smartScopeCount(recipes: HouseholdRecipeRow[], scope: SmartScope): number {
  if (scope === "favorites") return recipes.filter((r) => r.favorite).length;
  if (scope === "unpublished") return recipes.filter((r) => r.unpublished).length;
  return recipes.length;
}
