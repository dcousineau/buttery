import { useEffect } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { CloudOff } from "lucide-react";
import { seo } from "#/lib/seo";

/**
 * The precached offline shell (offline plan §4.4).
 *
 * The service worker's navigation handler falls back to **this** URL when the
 * network does not answer in 3 seconds — not to a cached copy of the page the
 * user asked for. That distinction is the whole design:
 *
 * SSR HTML embeds per-user state. The session, the household name, the gate
 * verdict and the first page of data are all baked into the document Buttery
 * serves, so caching an authenticated document means serving one household's
 * page to whoever opens the app next on a shared iPad. This route is the one
 * document with **no server data in it at all**, which is what makes it safe to
 * hand to anyone.
 *
 * What the user actually sees at, say, `/household/list` with no network: the
 * browser is handed this shell, the client router boots, reads the *requested*
 * URL from `window.location`, and renders that route — whose loader resolves
 * from IndexedDB rather than the network (§4.5). The copy below is therefore a
 * fallback for the fallback: it is what shows if the requested route is one that
 * has never been cached, or if there is genuinely nothing stored yet.
 *
 * `noindex` because a crawler that reaches this URL has found a loading state,
 * not a page.
 */
export const Route = createFileRoute("/offline")({
  head: () => ({
    meta: [
      ...seo({ title: "Offline · Buttery", description: "Buttery works without a connection once it has been opened at least once." }),
      { name: "robots", content: "noindex" },
    ],
  }),
  component: OfflineShell,
});

function OfflineShell() {
  const router = useRouter();

  /**
   * Hand the client router the URL the user actually asked for.
   *
   * The service worker serves *this* document for any navigation it cannot
   * reach the network for, so the browser's address bar says (say)
   * `/household/list` while the HTML it was handed describes `/offline`. The
   * router hydrates against the location, not the document, so it re-matches on
   * its own — but only once something tells it to look. This effect is that
   * something, and `replace` keeps the fallback out of the back stack.
   *
   * A no-op when someone navigates here directly, which is the only other way
   * to arrive.
   */
  useEffect(() => {
    const requested = window.location.pathname + window.location.search;
    if (window.location.pathname === "/offline") return;
    void router.navigate({ href: requested, replace: true });
  }, [router]);

  return (
    <div className="flex min-h-[60svh] flex-col items-center justify-center gap-3 px-6 text-center">
      <CloudOff className="size-10 text-muted-foreground" aria-hidden="true" />
      <div>
        <h1 className="display-title m-0 text-lg text-foreground">You're offline</h1>
        <p className="mt-1 mb-0 max-w-prose text-sm text-muted-foreground">
          Your recipe box, this week's plan and the shopping list are readable without a connection — as long as this phone has opened them at least once. Anything else needs the
          network.
        </p>
      </div>
    </div>
  );
}
