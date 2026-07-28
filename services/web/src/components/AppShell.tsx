import { useCallback, useRef } from "react";
import { useRouterState } from "@tanstack/react-router";
import { SidebarFloatingToggle, SidebarProvider, SidebarTrigger } from "#/components/ui/sidebar";
import { TooltipProvider } from "#/components/ui/tooltip";
import AppSidebar from "./AppSidebar";
import Footer from "./Footer";
import Header from "./Header";

/** Routes that render without the sidebar — just the shared header + footer. */
const NAVLESS_ROUTES = new Set(["/", "/login", "/terms", "/privacy", "/ai-usage"]);

/** Recipe detail pages render full-width (no sidebar) so the recipe owns the page. */
function isNavless(pathname: string): boolean {
  return NAVLESS_ROUTES.has(pathname) || pathname.startsWith("/recipes/");
}

function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only rounded-lg border-2 border-border bg-card px-4 py-2 font-semibold text-foreground shadow-pop focus-visible:not-sr-only focus-visible:fixed focus-visible:top-3 focus-visible:left-3 focus-visible:z-[60]"
    >
      Skip to main content
    </a>
  );
}

/** Publishes the live header height to `--header-height` so fixed layout offsets
 * sit below the full-width header. Returns a *callback ref* rather than an
 * effect-bound object ref: switching between the sidebar and nav-less layouts
 * remounts the header into a new DOM node, and a one-shot effect would keep
 * observing the detached old node — which fires a `0` resize on removal and
 * collapses the offset, clipping the top of the page. Re-binding on every node
 * change (and never writing on unmount) keeps the var pinned to the live header. */
function useHeaderHeightVar() {
  const observerRef = useRef<ResizeObserver | null>(null);
  return useCallback((el: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty("--header-height", `${el.offsetHeight}px`);
    set();
    const observer = new ResizeObserver(set);
    observer.observe(el);
    observerRef.current = observer;
  }, []);
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const headerRef = useHeaderHeightVar();

  if (isNavless(pathname)) {
    return (
      <div className="flex min-h-svh flex-col pt-[var(--header-height,4rem)]">
        <SkipLink />
        <Header ref={headerRef} />
        <main id="main-content" tabIndex={-1} className="flex-1 focus-visible:outline-none">
          {children}
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <TooltipProvider>
      <SidebarProvider className="flex-col">
        <SkipLink />
        <Header ref={headerRef} leftSlot={<SidebarTrigger className="md:hidden" />} />
        <div className="flex flex-1 pt-[var(--header-height,4rem)]">
          <AppSidebar />
          <SidebarFloatingToggle />
          <div className="relative flex w-full min-w-0 flex-1 flex-col bg-background">
            <main id="main-content" tabIndex={-1} className="flex-1 focus-visible:outline-none">
              {children}
            </main>
            <Footer />
          </div>
        </div>
      </SidebarProvider>
    </TooltipProvider>
  );
}
