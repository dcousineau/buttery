import * as React from "react";

/** The Lucide `loader-2` glyph, spinning at 1s linear. Goes inside a pending button. */
export interface SpinnerProps extends React.SVGAttributes<SVGSVGElement> {
  className?: string;
}

export declare function Spinner(props: SpinnerProps): JSX.Element;
