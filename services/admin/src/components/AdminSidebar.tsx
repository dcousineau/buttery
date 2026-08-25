import { Link, useRouterState } from "@tanstack/react-router";
import { Boxes, Database, GitCompareArrows, History, LayoutDashboard, LogOut, Radio, ShieldCheck, Users } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar";
import { Button } from "#/components/ui/button";
import type { AdminIdentity } from "#/server/session";
import { authClient } from "#/lib/auth-client";

/**
 * Section navigation.
 *
 * The grouping is the tool's mental model, and it is worth stating: **Network**
 * is atproto as the sweep found it, **Local** is what Postgres holds, and
 * **Access** is who may look. The whole reason the first two are separate
 * sections rather than one "Recipes" list is that the interesting cases are the
 * ones where they disagree — a section that merged them would be the app's read
 * path all over again.
 */
const SECTIONS: ReadonlyArray<{
  label: string;
  items: ReadonlyArray<{ to: string; label: string; icon: typeof Radio; exact?: boolean }>;
}> = [
  {
    label: "Overview",
    items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard, exact: true }],
  },
  {
    label: "Network (atproto)",
    items: [
      { to: "/network/recipes", label: "Recipe records", icon: Radio },
      { to: "/network/changes", label: "Recent changes", icon: History },
      { to: "/network/repos", label: "Repos", icon: Boxes },
      { to: "/network/sync-runs", label: "Sync runs", icon: GitCompareArrows },
    ],
  },
  {
    label: "Local (Postgres)",
    items: [{ to: "/local/recipes", label: "Recipes", icon: Database }],
  },
  {
    label: "Access",
    items: [{ to: "/operators", label: "Operators", icon: Users }],
  },
];

export function AdminSidebar({ identity }: { identity: AdminIdentity }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <Sidebar>
      <SidebarHeader className="gap-1 px-3 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="size-4" aria-hidden="true" />
          Buttery admin
        </span>
        <span className="text-xs text-muted-foreground">Backoffice — not a Buttery surface</span>
      </SidebarHeader>

      <SidebarContent>
        {SECTIONS.map((section) => (
          <SidebarGroup key={section.label}>
            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => {
                  // `startsWith` so a detail route keeps its section lit — an
                  // operator three levels into a record should still be able to
                  // see where they are.
                  const active = item.exact ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`);
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton asChild isActive={active}>
                        <Link to={item.to}>
                          <item.icon aria-hidden="true" />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="gap-2 px-3 py-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium">{identity.name}</p>
          <p className="truncate text-xs text-muted-foreground">{identity.email}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            // A hard navigation rather than the SPA router: it drops every
            // in-memory query result along with the session, so the next
            // operator to use this browser starts from nothing. The redirect
            // runs even if the request fails, so a stale session can never
            // strand someone on an authed screen.
            void authClient.signOut().finally(() => {
              window.location.href = "/login";
            });
          }}
        >
          <LogOut className="size-3.5" aria-hidden="true" />
          Sign out
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}
