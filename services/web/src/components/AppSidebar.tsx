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
  soon?: boolean;
};

const NAV_ENTRIES: Array<NavEntry> = [
  { label: "Home", icon: Home, to: "/pantry" },
  { label: "Recipes", icon: BookOpenText, to: "/household/recipes" },
  { label: "Collections", icon: FolderLock, soon: true },
  { label: "Shopping list", icon: ShoppingBasket, soon: true },
  { label: "Meal planner", icon: CalendarRange, soon: true },
  { label: "Randomizer", icon: Dices, to: "/household/recipes/randomizer" },
];

export default function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { setOpenMobile } = useSidebar();

  // Nested entries (e.g. "/household/recipes" and its child
  // "/household/recipes/randomizer") both prefix-match a child path, which
  // would light up BOTH simultaneously. Pick the single longest matching `to`
  // — the most specific route wins — rather than evaluating each entry
  // independently.
  const activeTo = NAV_ENTRIES.filter((e) => e.to && (pathname === e.to || pathname.startsWith(`${e.to}/`)))
    .map((e) => e.to as string)
    .sort((a, b) => b.length - a.length)[0];

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
                        // /household/recipes/{id}); the home route "/pantry" has
                        // no children so exact and prefix agree. Only the most
                        // specific match (`activeTo`, computed above) lights up.
                        isActive={entry.to === activeTo}
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
