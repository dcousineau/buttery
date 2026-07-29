import * as React from "react";

/** A 1px ink rule. The only hairline in the system — everything structural is 2px. */
export interface SeparatorProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "horizontal" | "vertical";
  className?: string;
}

export declare function Separator(props: SeparatorProps): JSX.Element;
