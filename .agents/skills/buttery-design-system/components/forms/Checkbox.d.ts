import * as React from "react";

/**
 * Buttery's checkbox — butter fill, ink border, hard shadow, sticker press. Four
 * size steps because checklists are everywhere in this product: `sm`/`default`
 * for dense UI, `lg` for a shopping list held in one hand in a store, `xl` for
 * cook mode (40px box, 24px label, tappable from a meter away).
 *
 * Radii are tightened at the small end (3px at 16px, 4px at 20px, 6px at 28px)
 * so a small checkbox never reads as a radio — the square corner IS the
 * affordance at that size.
 */
export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** 16 / 20 / 28 / 40px boxes. `xl` is the cook-mode step. */
  size?: "sm" | "default" | "lg" | "xl";
  /** Renders the dash glyph — use for a partially-checked recipe or aisle group. */
  indeterminate?: boolean;
  className?: string;
}

/**
 * A full-width checklist row: the whole row is the hit target, a checked item
 * strikes through and loses its shadow. Use for ingredients, shopping list lines,
 * and meal-plan claims.
 */
export interface CheckboxRowProps extends Omit<React.LabelHTMLAttributes<HTMLLabelElement>, "size"> {
  size?: "sm" | "default" | "lg" | "xl";
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** Right-aligned muted text — quantity, aisle, assignee. */
  meta?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

export declare function Checkbox(props: CheckboxProps): JSX.Element;
export declare function CheckboxRow(props: CheckboxRowProps): JSX.Element;
