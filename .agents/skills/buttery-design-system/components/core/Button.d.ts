import * as React from "react";

/**
 * Buttery's primary action control — 2px ink border, hard offset shadow, and
 * sticker physics (lifts on hover, presses on click) on every solid variant.
 */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** default = Crocker red CTA · secondary = butter · outline = paper w/ ink border · ghost/link = flat · destructive = deep red */
  variant?: "default" | "secondary" | "outline" | "ghost" | "destructive" | "link";
  /**
   * Text sizes 24/28/32/36px tall; icon-* are square at the same heights.
   * `xl` (48px) and `2xl` (64px) are the cook-mode steps — full-screen, read and
   * tapped from a meter away. Use them only on cook-mode / kiosk surfaces.
   */
  size?: "xs" | "sm" | "default" | "lg" | "xl" | "2xl" | "icon" | "icon-xs" | "icon-sm" | "icon-lg" | "icon-xl" | "icon-2xl";
  /** Render as another element/component (e.g. "a" for a link-styled button). */
  as?: React.ElementType;
  href?: string;
  className?: string;
  children?: React.ReactNode;
}

export declare function Button(props: ButtonProps): JSX.Element;
