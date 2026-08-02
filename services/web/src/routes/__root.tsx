import { HeadContent, Scripts, createRootRoute, useRouterState } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { PostHogProvider, usePostHog } from "@posthog/react";
import { useEffect, useRef } from "react";
import { authClient } from "../lib/auth-client";
import AppShell from "../components/AppShell";
import ComingSoon from "../components/ComingSoon";
import { getComingSoon } from "../lib/config";
import { absolute, seo } from "../lib/seo";

import appCss from "../styles.css?url";

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`;

export const Route = createRootRoute({
  loader: () => getComingSoon(),
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

/** Pages that stay reachable during the soft-launch gate (legal / transparency). */
const UNGATED_ROUTES = new Set(["/terms", "/privacy", "/ai-usage", "/acknowledgements"]);

function PostHogIdentity() {
  const posthog = usePostHog();
  const { data: session } = authClient.useSession();
  const did = session?.user.did;
  const identifiedDid = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!did) return;
    if (identifiedDid.current && identifiedDid.current !== did) posthog.reset();
    posthog.identify(did, {
      handle: session.user.handle ?? session.user.name,
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
  const posthogToken = import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN;
  const posthogHost = import.meta.env.VITE_PUBLIC_POSTHOG_HOST;
  if (import.meta.env.DEV && (!posthogToken || !posthogHost)) {
    console.error(
      `${!posthogToken ? "VITE_PUBLIC_POSTHOG_PROJECT_TOKEN" : "VITE_PUBLIC_POSTHOG_HOST"} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once the variable is configured`,
    );
  }
  const comingSoon = Route.useLoaderData();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const gated = comingSoon && !UNGATED_ROUTES.has(pathname);
  // Canonical / og:url are per-page; derive both from the current path so every
  // route gets them without per-route wiring. Query/hash are intentionally dropped.
  const canonical = absolute(pathname);
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
        <link rel="canonical" href={canonical} />
        <meta property="og:url" content={canonical} />
      </head>
      <body className="font-sans antialiased [overflow-wrap:anywhere] selection:bg-[rgba(255,216,77,0.55)]">
        {posthogToken && posthogHost ? (
          <PostHogProvider
            apiKey={posthogToken}
            options={{
              api_host: posthogHost,
              capture_exceptions: true,
              tracing_headers:
                typeof window !== "undefined" ? [window.location.hostname] : [],
            }}
          >
            <PostHogIdentity />
            {gated ? <ComingSoon /> : <AppShell>{children}</AppShell>}
          </PostHogProvider>
        ) : (
          <>{gated ? <ComingSoon /> : <AppShell>{children}</AppShell>}</>
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
