import { HeadContent, Scripts, createRootRouteWithContext, useRouterState } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import type { QueryClient } from "@tanstack/react-query";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { PostHogProvider } from "@posthog/react";
import { useEffect, useRef } from "react";
import { authClient } from "../lib/auth-client";
import AppShell from "../components/AppShell";
import Waitlist from "../components/Waitlist";
import { POSTHOG_CLIENT_CONFIG, useAnalytics } from "../lib/analytics";
import { fetchGateState, isOffline, type GateState } from "#/lib/api";
import { cacheGateState, gateStateOffline } from "#/lib/offline/session-cache";
import { useCachePartition } from "#/lib/offline/use-cache-partition";
import { absolute, seo } from "../lib/seo";

import appCss from "../styles.css?url";

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`;

/**
 * The gate verdict, with the offline arm §4.4 requires.
 *
 * This loader runs on **every** page in the app, and before this change it was
 * the single point that took the whole tree down without a network: a throwing
 * root loader means an error screen, not a degraded one, so an installed Buttery
 * in airplane mode showed nothing at all.
 *
 * On the server a failure still throws — there is no cache to fall back to and a
 * broken gate is a real bug worth surfacing. On the client it falls back to the
 * last known verdict, and to "authed and invited" when there is none, because the
 * gate is chrome (it picks between the app and a waitlist screen) and every
 * actual authorization is a server function that by definition reached the
 * server. §4.4 argues the direction at length: the failure mode of erring open
 * is a stranger seeing an empty shell; the failure mode of erring closed is the
 * household being locked out of its own shopping list in a store.
 */
async function loadGateState(): Promise<GateState> {
  try {
    return await fetchGateState();
  } catch (error) {
    if (typeof window === "undefined") throw error;
    // Not narrowed to `isOffline` alone: a service-worker-served shell, an
    // aborted navigation and a captive portal all fail differently, and none of
    // them is a reason to blank the app. The distinction is kept only so that a
    // genuinely broken gate still reaches the console.
    if (!isOffline(error)) console.warn("[gate] falling back to the cached verdict", error);
    return gateStateOffline();
  }
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  loader: () => loadGateState(),
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
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
      // iOS reads none of the web app manifest for home-screen installs — it
      // has its own decade-old meta vocabulary, and these three are what make an
      // installed Buttery open chrome-less with a warm status bar instead of as
      // a Safari tab with a white bar (§9.1).
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

/** Pages that stay reachable for a signed-in-but-not-invited user (legal /
 * transparency), so the waitlist takeover never traps them away from these. */
const UNGATED_ROUTES = new Set(["/terms", "/privacy", "/ai-usage", "/acknowledgements"]);

/** Route prefixes for the signed-in app surfaces. The PostHog support widget
 * (Conversations) is shown only here — never on marketing, legal, or public
 * share pages (`/`, `/login`, `/recipes/*`, `/invite/*`, …). */
const LOGGED_IN_ROUTE_PREFIXES = ["/household", "/households", "/onboarding"];

function isLoggedInRoute(pathname: string): boolean {
  return LOGGED_IN_ROUTE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Shows PostHog's Conversations "support widget" on signed-in app routes only.
 * The widget auto-loads from remote config; we `show()` it on app routes and
 * `hide()` it everywhere else. Calls are client-only (guarded by `useEffect`)
 * and no-op until conversations finish loading, so we poll briefly to still hide
 * an auto-shown widget once it lands on a marketing/legal page.
 *
 * Production-only, like the rest of analytics: outside production `conversations`
 * is permanently undefined and this component does nothing (see `lib/analytics`). */
function PostHogSupportWidget() {
  const { posthog } = useAnalytics();
  const loggedIn = useRouterState({ select: (s) => isLoggedInRoute(s.location.pathname) });

  useEffect(() => {
    const conversations = posthog.conversations;
    if (!conversations) return;
    const apply = () => {
      if (loggedIn) {
        // show() also kicks off the async load when conversations aren't ready.
        conversations.show();
        return true;
      }
      if (!conversations.isAvailable()) return false; // nothing rendered to hide yet
      conversations.hide();
      return true;
    };
    if (apply()) return;
    const timer = setInterval(() => {
      if (apply()) clearInterval(timer);
    }, 500);
    const stop = setTimeout(() => clearInterval(timer), 10_000);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [posthog, loggedIn]);

  return null;
}

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
    // `handle` the real atproto handle (server does the same in src/server/gate.ts);
    // `name` is the separate display fallback.
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
  const gate = Route.useLoaderData();
  // Snapshot the verdict from the *render*, not from the loader.
  //
  // On a cold page load the root loader runs on the server and its result is
  // dehydrated into the HTML — the client-side loader never executes, so a
  // `cacheGateState` call inside it writes nothing in the browser. (Verified:
  // after a full online session the session and active-household snapshots were
  // in localStorage and the gate's was not.) Rendering is the one place that
  // sees the value on both paths.
  useEffect(() => {
    cacheGateState(gate);
  }, [gate]);

  // Keeps the IndexedDB partition pointed at the signed-in household, and wipes
  // it when that changes (§2.7). Mounted at the root because a household switch
  // navigates, and any component below could unmount mid-switch.
  useCachePartition();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // A signed-in user without the `invited` flag gets the waitlist takeover,
  // except on the ungated legal pages so they can still read them / sign out.
  const gated = gate.authed && !gate.invited && !UNGATED_ROUTES.has(pathname);
  // Canonical / og:url are per-page; derive both from the current path so every
  // route gets them without per-route wiring. Query/hash are intentionally dropped.
  const canonical = absolute(pathname);
  // PostHog wraps the app in PRODUCTION ONLY; everywhere else the same tree
  // renders bare and posthog-js is never initialized (see `lib/analytics`).
  const app = gated ? <Waitlist /> : <AppShell>{children}</AppShell>;
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
            <PostHogSupportWidget />
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
          ]}
        />
        <Scripts />
      </body>
    </html>
  );
}
