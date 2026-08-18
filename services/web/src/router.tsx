import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { routeTree } from "./routeTree.gen";
import { NotFound } from "./components/NotFound";
import { isForbidden, shouldRetry } from "./lib/api";

/**
 * One QueryClient per request on the server, one per browser tab on the client —
 * `getRouter()` is called once per each, so a client built here is never shared
 * between two users' requests (offline plan §4.1).
 *
 * The two timings are the offline design in miniature:
 *
 * - `staleTime: 30s` — how long a payload is trusted without asking again. The
 *   grocery list overrides this down to 10s in its own factory, because it is the
 *   one surface two people touch at the same time.
 * - `gcTime: 24h` — how long an *unobserved* query stays in memory. This is not
 *   about memory; it is what gives the IndexedDB persister something to write.
 *   At the default 5 minutes, a query dropped on navigation is gone before the
 *   user reaches the store.
 *
 * `retry` refuses to burn attempts on answers the server already gave (401/403);
 * see `lib/api/errors.ts` for why that is a predicate over wire shapes rather
 * than an error class.
 */
/**
 * The §4.5 `forbidden` wipe, wired at the only place that sees every read and
 * every write: the cache's own error hooks.
 *
 * §4.5 lists a membership failure as a wipe trigger and `WipeReason` has always
 * reserved `"forbidden"` for it — but nothing ever called it, so being removed
 * from a household left its whole box readable on the device. It cannot live in
 * a route: the failure can come from any query or mutation, including a mirror
 * prefetch nobody is watching.
 *
 * Deliberately fired on the *server's* verdict rather than on a guess. Offline
 * failures do not reach here as `forbidden` (see `isOffline`, which now checks
 * server answers first), so a phone in a lift never wipes itself.
 */
function onCacheError(error: unknown): void {
  if (typeof window === "undefined" || !isForbidden(error)) return;
  void import("./lib/offline/partition").then(({ wipeCachePartition }) => wipeCachePartition("forbidden"));
}

export function getRouter() {
  const queryClient = new QueryClient({
    queryCache: new QueryCache({ onError: onCacheError }),
    mutationCache: new MutationCache({ onError: onCacheError }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 1000 * 60 * 60 * 24,
        retry: shouldRetry,
        /**
         * **The line that makes offline reads work at all.**
         *
         * Query's default `networkMode: "online"` *pauses* a fetch while
         * `onlineManager` says offline — `queryFn` is never called. And the
         * IndexedDB restore lives *inside* `queryFn`: the persister wraps it
         * (`lib/offline/persister.ts`). So under the default, going offline
         * means the persisted entry is never read and the loader's promise
         * never settles — the route simply hangs, with no error and no
         * `pendingComponent`.
         *
         * That failure hides well. `onlineManager` starts `true` and only
         * learns otherwise from an `offline` event, so a page *loaded* while
         * offline still believes it is online, fetches, restores from IDB and
         * looks perfect. It is the "went offline mid-session" case — the phone
         * that has been in a pocket since the last aisle, i.e. the whole point
         * of the feature — that breaks. Measured before this line: a tap on
         * Shopping list rendered nothing for 37s.
         *
         * `offlineFirst` attempts once regardless of the browser's guess, which
         * is what reaches the persister. When the entry is there the query
         * resolves from disk; when it is not, the fetch fails and the route's
         * `errorComponent` says so. The same setting also happens to be right
         * for captive portals, where `navigator.onLine` lies.
         */
        networkMode: "offlineFirst",
        // Coming back to the tab is the moment a stale list is most likely and
        // least expensive to fix — the behaviour `/household/plan` and
        // `/household/list` each hand-rolled with a throttled `focus` listener
        // and `router.invalidate()` before they moved onto Query (grocery D12,
        // planner D10). `staleTime` is the throttle now.
        refetchOnWindowFocus: true,
        // The single most important refetch for this feature: the phone that has
        // been in a pocket since the last aisle re-reads the moment it has signal.
        refetchOnReconnect: true,
      },
    },
  });

  const router = createTanStackRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    // §2.3: Query owns caching on the migrated routes, so the router's match
    // cache must not hold a second, differently-aged copy of the same payload.
    // Zero here means "always re-run the loader", and the loader's
    // `ensureQueryData` is what decides whether that costs a request.
    defaultPreloadStaleTime: 0,
    // Not just a nicer 404 page. Without this, every unmatched URL makes the
    // router warn on both the server and the client, and the devtools plugin
    // pipes each console line across the socket in both directions — so one
    // warning re-enters as a longer warning, forever, until the dev server
    // exhausts its heap. A configured component means the warning never fires.
    defaultNotFoundComponent: NotFound,
  });

  // Streams the server's query cache into the client's dehydrated payload, so an
  // SSR'd route paints from the same entry the client then owns — rather than
  // rendering server-side and immediately refetching everything on hydration.
  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
