import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { NotFound } from "./components/NotFound";

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    // Not just a nicer 404 page. Without this, every unmatched URL makes the
    // router warn on both the server and the client, and the devtools plugin
    // pipes each console line across the socket in both directions — so one
    // warning re-enters as a longer warning, forever, until the dev server
    // exhausts its heap. A configured component means the warning never fires.
    defaultNotFoundComponent: NotFound,
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
