import { Link, useRouterState } from "@tanstack/react-router";
import { BookOpenText, CalendarRange, Dices, FolderLock, Home, ShoppingBasket } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "#/components/ui/sidebar";
import type { ComponentType } from "react";

type NavEntry = {
  label: string;
  icon: ComponentType<{ className?: string }>;
  to?: string;
  /** Match `to` exactly instead of by prefix — for entries that are an ancestor
   * of another entry's path and would otherwise stay lit on its pages. */
  exact?: boolean;
  soon?: boolean;
};

const NAV_ENTRIES: Array<NavEntry> = [
  { label: "Home", icon: Home, to: "/household", exact: true },
  { label: "Recipes", icon: BookOpenText, to: "/household/recipes" },
  { label: "Collections", icon: FolderLock, soon: true },
  { label: "Shopping list", icon: ShoppingBasket, soon: true },
  { label: "Meal planner", icon: CalendarRange, to: "/household/plan" },
  { label: "Randomizer", icon: Dices, soon: true },
];

export default function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { setOpenMobile } = useSidebar();

  return (
    <Sidebar>
      <SidebarContent className="pt-2">
        <SidebarGroup>
          <SidebarGroupLabel>The pantry</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ENTRIES.map((entry) => {
                const Icon = entry.icon;
                return (
                  <SidebarMenuItem key={entry.label}>
                    {entry.to ? (
                      <SidebarMenuButton
                        // Prefix match keeps a section active on its child routes
                        // (e.g. /household/recipes stays active on
                        // /household/recipes/{id}). Home is "/household", the
                        // parent of every other section, so it opts out.
                        isActive={pathname === entry.to || (!entry.exact && pathname.startsWith(`${entry.to}/`))}
                        className="data-active:border-2 data-active:border-border data-active:shadow-pop-sm"
                        render={<Link to={entry.to} onClick={() => setOpenMobile(false)} />}
                      >
                        <Icon />
                        <span>{entry.label}</span>
                      </SidebarMenuButton>
                    ) : (
                      <>
                        <SidebarMenuButton aria-disabled="true" aria-label={`${entry.label} (coming soon)`}>
                          <Icon />
                          <span>{entry.label}</span>
                        </SidebarMenuButton>
                        <SidebarMenuBadge aria-hidden="true" className="text-[0.6rem] tracking-wide text-muted-foreground uppercase">
                          soon
                        </SidebarMenuBadge>
                      </>
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
