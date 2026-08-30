import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { AdminSidebar } from "#/components/AdminSidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "#/components/ui/sidebar";
import { fetchAdminIdentity } from "#/server/session";

/**
 * The gate. Every page except `/login` and `/api/auth/*` lives under this
 * pathless layout, so "is this operator allowed in" is asked in exactly one
 * place.
 *
 * The check runs in `beforeLoad` — before any child loader — so an unauthorised
 * request never reaches a query that would read someone's recipes. It is *not*
 * the only check: every server function calls `requireAdmin()` on its own,
 * because a route guard protects a page while the server functions behind it
 * are just HTTP endpoints anyone can call directly.
 *
 * The attempted URL rides along in `?redirect=`, so signing in lands the
 * operator where they were going rather than on the dashboard.
 */
export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ location }) => {
    const identity = await fetchAdminIdentity();
    if (!identity) {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
    // Handed down through router context so children (and the sidebar) can read
    // the operator without a second round trip.
    return { identity };
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const { identity } = Route.useRouteContext();

  return (
    <SidebarProvider>
      <AdminSidebar identity={identity} />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <span className="text-sm text-muted-foreground">Buttery backoffice</span>
        </header>
        <main className="flex-1 space-y-6 p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
