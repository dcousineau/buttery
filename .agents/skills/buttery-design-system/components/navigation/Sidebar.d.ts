import * as React from "react";

/**
 * The logged-in app's left nav rail (16rem, cream fill, 2px ink right edge).
 * The active item is the system's clearest state signal: butter fill PLUS a 2px
 * ink border PLUS a 2px hard shadow — it reads as a sticker pressed onto the rail.
 */
export interface SidebarMenuButtonProps extends React.HTMLAttributes<HTMLElement> {
  /** Butter fill + ink border + hard shadow. */
  isActive?: boolean;
  as?: React.ElementType;
  href?: string;
  /** Unbuilt features render with aria-disabled and a "soon" SidebarMenuBadge. */
  "aria-disabled"?: boolean | "true" | "false";
  className?: string;
}

export declare function Sidebar(props: React.HTMLAttributes<HTMLElement>): JSX.Element;
export declare function SidebarContent(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function SidebarGroup(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function SidebarGroupLabel(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function SidebarMenu(props: React.HTMLAttributes<HTMLUListElement>): JSX.Element;
export declare function SidebarMenuItem(props: React.HTMLAttributes<HTMLLIElement>): JSX.Element;
export declare function SidebarMenuButton(props: SidebarMenuButtonProps): JSX.Element;
export declare function SidebarMenuBadge(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
