import * as React from "react";

/**
 * Betty-Crocker gingham as a component wrapper around the `.gingham-band` /
 * `.gingham` CSS utilities. Intentional addition: the source ships these as CSS
 * classes only, but every chrome surface repeats the same 14px band, so having it
 * as one component keeps the "trim, not wallpaper" rule enforceable.
 */
export interface GinghamBandProps extends React.HTMLAttributes<HTMLDivElement> {
  /** `band` = 14px chrome strip (default). `field` = 20px check tablecloth, cards required on top. */
  variant?: "band" | "field";
  className?: string;
}

export declare function GinghamBand(props: GinghamBandProps): JSX.Element;
