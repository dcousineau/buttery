import * as React from "react";

/**
 * Click-to-open menu on a popover surface (2px ink border, 4px hard shadow).
 * Buttery uses exactly one: the household switcher in the header.
 */
export interface DropdownMenuProps {
  defaultOpen?: boolean;
  children?: React.ReactNode;
}

export interface DropdownMenuContentProps extends React.HTMLAttributes<HTMLDivElement> {
  align?: "start" | "end";
  side?: "top" | "bottom";
  className?: string;
}

export interface DropdownMenuItemProps extends React.HTMLAttributes<HTMLElement> {
  variant?: "default" | "destructive";
  as?: React.ElementType;
  href?: string;
  className?: string;
}

export declare function DropdownMenu(props: DropdownMenuProps): JSX.Element;
/** Wraps a single child (usually a Button) and toggles the menu. */
export declare function DropdownMenuTrigger(props: { children: React.ReactElement }): JSX.Element;
export declare function DropdownMenuContent(props: DropdownMenuContentProps): JSX.Element | null;
export declare function DropdownMenuGroup(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function DropdownMenuLabel(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function DropdownMenuItem(props: DropdownMenuItemProps): JSX.Element;
export declare function DropdownMenuSeparator(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function DropdownMenuShortcut(props: React.HTMLAttributes<HTMLSpanElement>): JSX.Element;
