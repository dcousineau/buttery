import * as React from "react";

/**
 * Pill-shaped label with the ink border. Buttery uses it as an eyebrow above page
 * titles, as a role/status chip, and as a metadata tag row.
 *
 * Badge sits on the SHARED control-height scale, so a badge, button, input and
 * select at the same `size` are the same height. `size="xs"` (24px) is the inline
 * chip the app ships today; `size="default"` (32px) matches a default button.
 */
export interface BadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "size"> {
  variant?: "default" | "secondary" | "outline" | "ghost" | "destructive" | "link";
  /** 24 / 28 / 32 / 36 / 48 / 64px — identical to Button and Input. */
  size?: "xs" | "sm" | "default" | "lg" | "xl" | "2xl";
  as?: React.ElementType;
  className?: string;
  children?: React.ReactNode;
}

export declare function Badge(props: BadgeProps): JSX.Element;
