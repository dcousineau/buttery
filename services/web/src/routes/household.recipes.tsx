import { useState } from "react";
import { createFileRoute, Outlet, useParams, useRouter, useRouterState } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import * as z from "zod";
import { householdCollectionsQuery, householdRecipesQuery } from "#/lib/api";
import { ensureActiveHousehold } from "#/lib/offline/active-household";
import { OfflineRouteError } from "#/components/offline/OfflineRouteError";
import { useRecipeMirror } from "#/lib/offline/use-recipe-mirror";
import { RecipeLedger } from "#/components/recipes/RecipeLedger";
import { CollectionsColumn } from "#/components/collections/CollectionsColumn";
import { resolveScope, SMART_SCOPES } from "#/components/collections/scope";
import { useCollectionsColumn } from "#/components/collections/use-collections-column";
import { RecipesViewProvider } from "#/components/recipes/RecipesViewProvider";
import { Pane } from "#/components/ui/pane";
import { useRecipesView } from "#/components/recipes/context";
import { cn } from "#/lib/utils";
import { seo } from "#/lib/seo";

/**
 * The recipes master–detail shell (plan §5.1). A layout route: the ledger (left)
 * stays mounted while the detail (`$id` child) or the empty-state (`index` child)
 * renders in the right pane via <Outlet/> — so selecting a recipe keeps the
 * ledger's scroll/place and never re-fetches it. The loader gates through
 * `requireActiveHousehold` (the stale-active guard) exactly like `/household`, then
 * primes the box query.
 *
 * **Offline-capable (offline plan §4.1).** The box comes from
 * `householdRecipesQuery`, so it is persisted to IndexedDB, refetched on
 * reconnect, and — via `useRecipeMirror` — the work queue the mini-mirror walks
 * to make every *detail* readable offline too (§4.6). The loader primes the same
 * cache entry the component then observes, which is what keeps SSR streaming.
 * Collections ride along beside it for the same reason (collections plan §6): a
 * household should be able to browse "Weeknights" on a phone with no signal.
 *
 * `requireActiveHousehold` is still awaited rather than folded into a query: it
 * is a redirect, not data — its whole job is to throw before anything renders
 * when the active household went stale.
 *
 * ## Three columns, and the URL that scopes them
 *
 * The collections tree is the third column (collections plan §7), collapsed by
 * default and toggled from the ledger's filter bar. What the ledger shows is
 * **URL state**, on this layout route so that it survives selecting a recipe:
 *
 * - `?scope=mine|favorites|recent|unpublished` — the smart rows. Absent means
 *   `mine`, the whole box A–Z, so the landing view has exactly one spelling.
 * - `?c=<collectionId>` — a collection, and it wins when both are present.
 *
 * Both are `.catch()`-guarded like every other search param in the app: a
 * hand-mangled `?scope=banana` renders the whole box rather than throwing a route
 * error at someone who only mistyped a URL, and a `?c=` naming a collection that
 * has since been deleted is an inline empty state, never a 404 (§8).
 *
 * Neither is a `loaderDep`, on purpose: scoping is a client-side rearrangement of
 * two cache entries that are already here (`components/collections/scope.ts`), so
 * switching shelves costs no round trip and cannot show a spinner mid-scan.
 */

const searchSchema = z.object({
  scope: z.enum(SMART_SCOPES).optional().catch(undefined),
  /** A collection id — an app ULID, but never shape-validated: the DB is the only truth. */
  c: z.string().optional().catch(undefined),
});

/** The collections column's DOM id, shared with the ledger toggle's `aria-controls`. */
const COLLECTIONS_PANEL_ID = "collections-column";

export const Route = createFileRoute("/household/recipes")({
  validateSearch: searchSchema,
  // The stale-active guard, and the cache partition, in one step. `beforeLoad`
  // rather than `loader` because its result is *context* — the `$id` child needs
  // the household id to build its own query key, and a loader's return value is
  // not visible to a child route.
  beforeLoad: async () => ({ ...(await ensureActiveHousehold()) }),
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(householdRecipesQuery(context.householdId)),
      context.queryClient.ensureQueryData(householdCollectionsQuery(context.householdId)),
    ]),
  head: () => ({ meta: seo({ title: "Recipes · Buttery", description: "Your household's recipe box." }) }),
  // An offline-capable route renders what has been cached; when the answer is
  // "nothing yet", that is a state, not a crash (§4.4).
  errorComponent: OfflineRouteError,
  component: RecipesLayout,
});

function RecipesLayout() {
  const { householdId } = Route.useRouteContext();
  const router = useRouter();

  // The shell — scale + view context, the two global modals and the toast queue
  // — is `RecipesViewProvider` now, because the randomizer mounts the same pane
  // on a route of its own (randomizer plan §6.1). What used to be this
  // component's provider block moved there verbatim; what stays here is the
  // half that is genuinely about *this* surface: adding a recipe selects it in
  // the ledger, which a route with no ledger has nothing to do with.
  return (
    <RecipesViewProvider householdId={householdId} onAdded={(recipeId) => router.navigate({ to: "/household/recipes/$id", params: { id: recipeId }, search: (prev) => prev })}>
      <RecipesLayoutColumns householdId={householdId} />
    </RecipesViewProvider>
  );
}

/** The three columns. Split out only so it can read `useRecipesView()` — the
 * ledger's "Add" button opens the shell's chooser, and the provider has to be
 * an ancestor for that handle to exist. */
function RecipesLayoutColumns({ householdId }: { householdId: string }) {
  // The hook, not the loader's return value: an unobserved query gets no
  // refetch-on-reconnect, no invalidation and no gc protection — which is
  // precisely the machinery offline depends on (§4.1).
  const { data: recipes } = useSuspenseQuery(householdRecipesQuery(householdId));
  const { data: collections } = useSuspenseQuery(householdCollectionsQuery(householdId));
  // Walks the box in idle time so an unvisited recipe still opens in a store.
  useRecipeMirror(householdId, recipes);
  const search = Route.useSearch();
  const { openAddChooser } = useRecipesView();
  // On a child ($id) route, params.id is the selected recipe; on the index it is
  // undefined. `strict: false` lets this read the child param from the layout.
  const params = useParams({ strict: false });
  const selectedId = (params as { id?: string }).id ?? null;
  const hasSelection = selectedId != null;

  // The full-page create form (`/household/recipes/new`) renders full width — the
  // ledger + column + picker are suppressed for it (plan §A5: the form is a full page).
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onNewForm = pathname.endsWith("/recipes/new");

  // One resolver for both columns: the tree's highlight and the ledger's rows
  // are the same decision, and two copies of it would drift.
  const scope = resolveScope(search, collections);
  const collectionsColumn = useCollectionsColumn();

  // Search text is a lens over the active scope, not a place — so it stays local
  // rather than joining the scope in the URL (collections plan §7).
  const [query, setQuery] = useState("");

  return (
    <Pane>
      {!onNewForm && (
        <>
          <CollectionsColumn id={COLLECTIONS_PANEL_ID} householdId={householdId} open={collectionsColumn.open} hasSelection={hasSelection} />
          {/*
            The ledger column. The mobile collections trigger is the ledger's
            own collapsing head now (it has to live inside the ledger's
            scrollport to scroll away), so this wrapper is just the responsive
            sizing: with a recipe selected below `lg` the whole column yields to
            the detail pane, and the way into a collection from there is the
            recipe's own "File this recipe" button.
          */}
          <div className={cn("flex min-h-0 w-full flex-col lg:w-[360px] lg:shrink-0", hasSelection ? "hidden lg:flex" : "flex")}>
            <RecipeLedger
              recipes={recipes}
              scope={scope}
              selectedId={selectedId}
              query={query}
              onQueryChange={setQuery}
              onAdd={openAddChooser}
              collectionsOpen={collectionsColumn.open}
              onToggleCollections={collectionsColumn.toggle}
              collectionsPanelId={COLLECTIONS_PANEL_ID}
              className="min-h-0 w-full flex-1"
            />
          </div>
        </>
      )}
      <section className={cn("min-h-0 min-w-0 flex-1 flex-col bg-background", onNewForm || hasSelection ? "flex" : "hidden lg:flex")}>
        <Outlet />
      </section>
    </Pane>
  );
}
