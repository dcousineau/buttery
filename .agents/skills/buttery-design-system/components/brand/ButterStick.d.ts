import * as React from "react";

/**
 * The Buttery mascot/mark — a flat stick of butter with ink outlines and
 * "BUTTER" set in Alfa Slab One on the wrapper. Ships at two sizes in practice:
 * 24–28px tall in the header wordmark, 13–16rem wide in a hero.
 */
export interface ButterStickProps extends React.SVGAttributes<SVGSVGElement> {
  /** Provide only when the mark is meaningful content; omit for decorative use (it then renders aria-hidden). */
  label?: string;
  className?: string;
}

export declare function ButterStick(props: ButterStickProps): JSX.Element;
