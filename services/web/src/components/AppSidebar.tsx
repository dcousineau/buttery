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
  { label: "Home", icon: Home, to: "/" },
  { label: "Recipes", icon: BookOpenText, soon: true },
  { label: "Collections", icon: FolderLock, soon: true },
  { label: "Shopping list", icon: ShoppingBasket, soon: true },
  { label: "Meal planner", icon: CalendarRange, soon: true },
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
                        isActive={pathname === entry.to}
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
