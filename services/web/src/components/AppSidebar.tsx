import { Link, useRouterState } from "@tanstack/react-router";
import { BookOpenText, CalendarRange, Dices, FolderLock, Home, ShoppingBasket } from "lucide-react";
import ButterStick from "./ButterStick";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
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
      <SidebarHeader>
        <Link to="/" onClick={() => setOpenMobile(false)} className="flex items-center gap-2 px-1 py-1 text-sidebar-foreground no-underline">
          <ButterStick className="h-7 w-auto" />
          <span className="display-title text-xl leading-none">Buttery</span>
        </Link>
      </SidebarHeader>
      <div className="gingham-band" aria-hidden="true" />
      <SidebarContent>
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
