import { HeadContent, Scripts, createRootRouteWithContext, useRouterState } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import type { QueryClient } from "@tanstack/react-query";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { PostHogProvider } from "@posthog/react";
import { useEffect, useRef } from "react";
import { authClient } from "../lib/auth-client";
import AppShell from "../components/AppShell";
import { POSTHOG_CLIENT_CONFIG, useAnalytics } from "../lib/analytics";
import { SupportDialog } from "../components/SupportDialog";
import { useCachePartition } from "#/lib/offline/use-cache-partition";
import { recipeInspectorPlugin } from "#/devtools/plugin";
import { absolute, seo } from "../lib/seo";

import appCss from "../styles.css?url";

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`;

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        // `viewport-fit=cover` is what lets a standalone iOS window paint under
        // the notch and the home indicator — without it the OS letterboxes the
        // page in black bars. It is only safe because `AppShell` and the two
        // PWA affordances inset themselves with `env(safe-area-inset-*)`;
        // adding it without those would put cook mode's controls under the home
        // indicator (offline plan §4.4).
        //
        // `maximum-scale=1, user-scalable=no` asks the browser not to let a
        // pinch scale this page: it is an app, and a pinch mid-recipe is nearly
        // always a fumble.
        //
        // Who honours it: Android Chrome, and an iOS home-screen install.
        // **A Safari tab on iOS does not** — it has overridden both since iOS
        // 10 and lets the pinch through on purpose, and no viewport value
        // changes that. Blocking it in the tab too would take a script
        // (`preventDefault` on WebKit's `gesturestart`), which is a different
        // decision from this one and is not made here.
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no",
      },
      // iOS reads none of the web app manifest for home-screen installs — it
      // has its own decade-old meta vocabulary, and these are what make an
      // installed Buttery open chrome-less with a warm status bar instead of as
      // a Safari tab with a white bar (§9.1).
      //
      // `mobile-web-app-capable` is the standardized name and the one Chrome
      // wants; Safari still only reads the `apple-` prefixed spelling, so both
      // ship. Dropping the Apple one to silence Chrome's console warning would
      // cost us the standalone iOS window the warning is not even about.
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "Buttery" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      { name: "theme-color", content: "#FFD84D" },
      ...seo(),
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      // The manifest has existed in `public/` since the CRA days, linked from
      // nowhere — so nothing was installable. This line is what turns it on.
      { rel: "manifest", href: "/manifest.json" },
      // iOS ignores the manifest's icons entirely; this is the one it uses.
      //
      // The *non*-maskable art, deliberately. A maskable icon carries ~20% of
      // safe-zone padding so that Android can crop it to a circle, a squircle or
      // a rounded square without losing the mark — and iOS applies no mask at
      // all beyond its own corner rounding, so it would render that padding as
      // dead space and the butter block would sit visibly smaller than every
      // icon beside it on the home screen (measured: the mark spans 60% of the
      // maskable canvas against 75% of this one). `logo192.png` already exists
      // and is the right art; its own corner radius (~11%) is well inside the
      // squircle iOS clips to (~22%), so the transparent corners never show as
      // the black iOS composites transparency onto. 192 rather than Apple's
      // nominal 180 — iOS downscales, and inventing a third icon file to save a
      // resample is not worth a new asset.
      { rel: "apple-touch-icon", href: "/logo192.png" },
    ],
  }),
  shellComponent: RootDocument,
});

function PostHogIdentity() {
  const { posthog } = useAnalytics();
  const { data: session } = authClient.useSession();
  const did = session?.user.did;
  const identifiedDid = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!did) return;
    if (identifiedDid.current && identifiedDid.current !== did) posthog.reset();
    // DID is the primary lookup id (distinct_id); handle rides along as a person
    // property so PostHog is filterable by handle, not just the opaque DID. Keep
    // `handle` the real atproto handle; `name` is the separate display fallback.
    posthog.identify(did, {
      ...(session.user.handle ? { handle: session.user.handle } : {}),
      name: session.user.name,
    });
    identifiedDid.current = did;
  }, [did, posthog, session?.user.handle, session?.user.name]);

  useEffect(() => {
    const reset = () => {
      posthog.reset();
      identifiedDid.current = undefined;
    };
    window.addEventListener("posthog:reset", reset);
    return () => window.removeEventListener("posthog:reset", reset);
  }, [posthog]);

  return null;
}

function RootDocument({ children }: { children: React.ReactNode }) {
  // Keeps the IndexedDB partition pointed at the signed-in household, and wipes
  // it when that changes (§2.7). Mounted at the root because a household switch
  // navigates, and any component below could unmount mid-switch.
  useCachePartition();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Canonical / og:url are per-page; derive both from the current path so every
  // route gets them without per-route wiring. Query/hash are intentionally dropped.
  const canonical = absolute(pathname);
  // PostHog wraps the app in PRODUCTION ONLY; everywhere else the same tree
  // renders bare and posthog-js is never initialized (see `lib/analytics`).
  const app = <AppShell>{children}</AppShell>;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
        <link rel="canonical" href={canonical} />
        <meta property="og:url" content={canonical} />
      </head>
      <body className="font-sans antialiased [overflow-wrap:anywhere] selection:bg-[rgba(255,216,77,0.55)]">
        {POSTHOG_CLIENT_CONFIG ? (
          <PostHogProvider
            apiKey={POSTHOG_CLIENT_CONFIG.apiKey}
            options={{
              api_host: POSTHOG_CLIENT_CONFIG.host,
              capture_exceptions: true,
              // Don't mint a person profile for anonymous visitors — events are
              // still captured (lightly tracked), but a profile is only created
              // once `identify()` runs on login. Keeps anon users out of Persons.
              person_profiles: "identified_only",
              // Inject the session id into requests to our own origin (API is
              // same-origin server functions) so backend instrumentation can
              // link server traces to the session. Client-only: `window` is
              // undefined during SSR.
              tracing_headers: typeof window !== "undefined" ? [window.location.hostname] : [],
            }}
          >
            <PostHogIdentity />
            {/* The support conversation, opened from the account menu. At the
                root because the menu's popup is unmounted the instant the item
                is clicked, so it cannot host what it opens (see `lib/support`). */}
            <SupportDialog />
            {app}
          </PostHogProvider>
        ) : (
          app
        )}
        <TanStackDevtools
          config={{
            position: "bottom-right",
          }}
          plugins={[
            {
              name: "Tanstack Router",
              render: <TanStackRouterDevtoolsPanel />,
            },
            // The offline surface is a cache, so "what is in the cache, how old
            // is it, and is it persisted" is the question every offline bug
            // starts from. §2.2 exists so that this panel is the ONLY place that
            // question has an answer — the service worker never caches data.
            {
              name: "Tanstack Query",
              render: <ReactQueryDevtoolsPanel />,
            },
            // Raw internal data for the recipe currently being viewed — the
            // atproto record, dedupe counterparts, and every private sidecar
            // table, undecorated. Dev-only twice over: `plugin.tsx` swaps in
            // a no-op for production builds, and the server fn behind it
            // re-checks `NODE_ENV` regardless (`devtools/types.ts`).
            recipeInspectorPlugin,
          ]}
        />
        <Scripts />
      </body>
    </html>
  );
}
