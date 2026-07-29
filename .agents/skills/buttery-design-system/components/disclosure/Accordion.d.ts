import * as React from "react";

/**
 * Stacked collapsible sections, each a card in its own right (ink border, hard
 * shadow that grows when open). Built for recipes broken into stages, grouped
 * shopping lists by aisle, and FAQ-style prose. Defaults to `multiple` because
 * a cook wants two stages open at once.
 */
export interface AccordionProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "size"> {
  type?: "single" | "multiple";
  /** Item `value`s open on first render. */
  defaultOpen?: string[];
  /** `xl` is the cook-mode step (48px triggers, 1.25rem labels). */
  size?: "sm" | "default" | "xl";
  className?: string;
}

export interface AccordionItemProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Identity used by open/close state — required. */
  value: string;
  className?: string;
}

export declare function Accordion(props: AccordionProps): JSX.Element;
export declare function AccordionItem(props: AccordionItemProps): JSX.Element;
export declare function AccordionTrigger(props: React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element;
export declare function AccordionContent(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element | null;
