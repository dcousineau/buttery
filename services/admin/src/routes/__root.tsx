import { HeadContent, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

import appCss from "../styles.css?url";

/** A grey shield on transparent — deliberately not a Buttery mark. */
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#525252" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>',
  );

/**
 * The admin's document shell. Stock shadcn tokens, no brand fonts, no analytics,
 * no service worker — see the header of `src/styles.css` for why the visual
 * distance from the app is deliberate.
 *
 * `noindex, nofollow` is belt-and-braces: nothing here is meant to be reachable
 * from the internet in the first place (the service is not deployed), but a tool
 * whose every page is someone else's data should never be one misconfigured
 * ingress away from being crawled.
 */
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "robots", content: "noindex, nofollow" },
      { title: "Buttery admin" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      // An inline data-URI rather than a file: the admin ships no static assets
      // and does not deserve a build step to gain one. It exists because the
      // app's dev server and this one are usually open in adjacent tabs, and a
      // blank favicon next to Buttery's is one wrong click away from an
      // operator editing production data thinking they are in the app. Also
      // silences the 404 every page load would otherwise log.
      { rel: "icon", href: FAVICON },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
