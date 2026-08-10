import { HeadContent, Scripts, createRootRoute, useRouterState } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { PostHogProvider } from "@posthog/react";
import { useEffect, useRef } from "react";
import { authClient } from "../lib/auth-client";
import AppShell from "../components/AppShell";
import Waitlist from "../components/Waitlist";
import { POSTHOG_CLIENT_CONFIG, useAnalytics } from "../lib/analytics";
import { getGateState } from "../lib/gate";
import { absolute, seo } from "../lib/seo";

import appCss from "../styles.css?url";

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`;

export const Route = createRootRoute({
  loader: () => getGateState(),
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      ...seo(),
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
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
const LOGGED_IN_ROUTE_PREFIXES = ["/household", "/households", "/pantry", "/onboarding"];

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
    // `handle` the real atproto handle (server does the same in src/lib/gate.ts);
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
          ]}
        />
        <Scripts />
      </body>
    </html>
  );
}
