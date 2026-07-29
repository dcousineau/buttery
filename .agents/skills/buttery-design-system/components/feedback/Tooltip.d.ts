import * as React from "react";

/**
 * Inverted tooltip (ink fill, cream text) with a rotated-square arrow. Note the
 * deliberate exception: the tooltip has NO border and NO offset shadow — it is
 * the one surface in Buttery that reads as a flat inverted chip.
 */
export interface TooltipProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Tooltip body. Keep it to a short phrase. */
  content: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
  children?: React.ReactNode;
}

export declare function Tooltip(props: TooltipProps): JSX.Element;
