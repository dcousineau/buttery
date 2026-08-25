import { QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { routeTree } from "./routeTree.gen";

/**
 * One QueryClient per request on the server, one per browser tab on the client.
 *
 * The admin's caching posture is the opposite of the app's. The app optimises
 * for a phone in a pocket; this optimises for an operator who has just changed
 * something in the database and wants to see it. So: a short `staleTime`, a
 * refetch when the tab regains focus, and no persistence anywhere — an internal
 * tool has no business leaving other people's recipe data in an operator's
 * IndexedDB.
 */
export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: true,
        // Two attempts, not three: a failing admin query is nearly always a
        // real answer (a redirect to /login, a bad filter) rather than a blip,
        // and retrying it just delays the error the operator needs to read.
        retry: 1,
      },
    },
  });

  const router = createTanStackRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    // Query owns caching; the router's match cache must not hold a second,
    // differently-aged copy of the same payload.
    defaultPreloadStaleTime: 0,
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
