import { Link, Outlet, createFileRoute } from "@tanstack/react-router";
import { Home, Plug, UserRound } from "lucide-react";
import type { ComponentType } from "react";

const SETTINGS_NAV: Array<{ label: string; to: "/settings/account" | "/settings/households" | "/settings/connections"; icon: ComponentType<{ className?: string }> }> = [
  { label: "Account", to: "/settings/account", icon: UserRound },
  { label: "Household", to: "/settings/households", icon: Home },
  { label: "Connections", to: "/settings/connections", icon: Plug },
];

/**
 * Settings shell: the app sidebar comes from `AppShell`; this adds the
 * secondary section nav and owns the page padding + width wrapper. Child pages
 * render only their own content (cap their own max width) — no `page-wrap`.
 * Each child route does its own auth/household guarding in its loader.
 */
export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  return (
    <div className="page-wrap px-4 pt-8 pb-12 sm:pt-10">
      <div className="flex flex-col gap-6 md:flex-row md:items-start md:gap-10">
        <nav aria-label="Settings" className="md:sticky md:top-[calc(var(--header-height,4rem)+1.5rem)] md:w-52 md:shrink-0">
          <ul className="flex flex-wrap gap-2 md:flex-col md:gap-1">
            {SETTINGS_NAV.map(({ label, to, icon: Icon }) => (
              <li key={to}>
                <Link
                  to={to}
                  activeProps={{ "aria-current": "page" }}
                  className="flex min-h-9 touch:min-h-(--control-h-touch) items-center gap-2 rounded-lg border-2 border-transparent px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-sidebar-accent aria-[current=page]:border-border aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-semibold aria-[current=page]:shadow-pop-sm"
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
