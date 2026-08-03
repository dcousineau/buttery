import { createFileRoute } from "@tanstack/react-router";
// The bookmarklet loader "bundle" (plan §C1) — authored as a standalone browser
// script and imported raw so Vite ships its source as a string. We substitute the
// real app origin for the `__BUTTERY_ORIGIN__` placeholder at request time so the
// loader knows which origin to open the bridge tab on and pin postMessage to.
import loaderSource from "#/bookmarklet/loader.js?raw";
import { APP_URL } from "#/lib/atproto/oauth-node";

/**
 * Serves `/bookmarklet.js` — the script the tiny `javascript:` bookmarklet injects
 * from our origin (see BookmarkletInstallDialog). Static content-type + a short
 * cache; the bracket-escaped filename mirrors oauth-client-metadata[.]json.ts.
 */
export const Route = createFileRoute("/bookmarklet.js")({
  server: {
    handlers: {
      GET: () => {
        const body = loaderSource.replaceAll("__BUTTERY_ORIGIN__", APP_URL);
        return new Response(body, {
          headers: {
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "public, max-age=300",
          },
        });
      },
    },
  },
});
