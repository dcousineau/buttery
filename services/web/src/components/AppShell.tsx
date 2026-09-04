import { useRouterState } from "@tanstack/react-router";
import { useHeightVar } from "#/lib/hooks/use-height-var";
import { SidebarFloatingToggle, SidebarProvider, SidebarTrigger } from "#/components/ui/sidebar";
import { TooltipProvider } from "#/components/ui/tooltip";
import AppSidebar from "./AppSidebar";
import Footer from "./Footer";
import Header from "./Header";
import { InstallPrompt } from "./offline/InstallPrompt";
import { UpdateBanner } from "./offline/UpdateBanner";

/** Routes that render without the sidebar — just the shared header + footer. */
const NAVLESS_ROUTES = new Set(["/", "/login", "/terms", "/privacy", "/ai-usage", "/acknowledgements", "/tip-jar", "/onboarding", "/households/switch"]);

/** Recipe detail pages and the auth-flow / invite screens render full-width (no
 * sidebar) so the focused task owns the page. */
function isNavless(pathname: string): boolean {
  return NAVLESS_ROUTES.has(pathname) || pathname.startsWith("/recipes/") || pathname.startsWith("/invite/");
}

/** Application views (the `/household/*` surfaces: the recipes master–detail,
 * the meal planner). They keep the sidebar but drop the marketing footer, and
 * from `md` up `main` is pinned to the viewport so only the inner panes scroll.
 * Below `md` the document scrolls instead — see `components/ui/pane.tsx`. */
function isAppView(pathname: string): boolean {
  return pathname.startsWith("/household/");
}

function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only rounded-lg border-2 border-border bg-card px-4 py-2 font-semibold text-foreground shadow-pop focus-visible:not-sr-only focus-visible:fixed focus-visible:top-3 focus-visible:left-3 focus-visible:z-(--z-skip-link)"
    >
      Skip to main content
    </a>
  );
}

/**
 * The two PWA affordances that have to outlive every route (offline plan §4.4):
 * the "new version ready" banner, which is a standing offer rather than a
 * transient toast, and the install sheet, which is a data-durability feature
 * (§9.1 — an installed app is exempt from Safari's seven-day eviction). Both
 * render nothing until they have something to say.
 */
function PwaAffordances() {
  return (
    <>
      <UpdateBanner />
      <InstallPrompt />
    </>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // `--header-height` is what every app view measures its own height against.
  const headerRef = useHeightVar("--header-height");

  if (isNavless(pathname)) {
    return (
      <div className="flex min-h-svh flex-col pt-[var(--header-height,4rem)]">
        <SkipLink />
        <Header ref={headerRef} />
        <main id="main-content" tabIndex={-1} className="flex-1 focus-visible:outline-none">
          {children}
        </main>
        <Footer />
        <PwaAffordances />
      </div>
    );
  }

  // The header only gets out of the way on app views (see `Header`): the landing
  // and the marketing pages are browsing surfaces where this bar is the
  // navigation, and it stays put there.
  const appView = isAppView(pathname);
  return (
    <TooltipProvider>
      <SidebarProvider className="flex-col">
        <SkipLink />
        <Header ref={headerRef} leftSlot={<SidebarTrigger className="md:hidden" />} headroom={appView} />
        <div className="flex flex-1 pt-[var(--header-height,4rem)]">
          <AppSidebar />
          <SidebarFloatingToggle />
          <div className="relative flex w-full min-w-0 flex-1 flex-col bg-background">
            <main
              id="main-content"
              tabIndex={-1}
              className={appView ? "flex flex-1 flex-col focus-visible:outline-none md:min-h-0 md:overflow-hidden" : "flex-1 focus-visible:outline-none"}
            >
              {children}
            </main>
            {appView ? null : <Footer />}
          </div>
        </div>
        <PwaAffordances />
      </SidebarProvider>
    </TooltipProvider>
  );
}
