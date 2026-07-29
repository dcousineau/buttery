import * as React from "react";

/** Pulsing muted block for pending auth/session state. Size it with style or className. */
export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string;
}

export declare function Skeleton(props: SkeletonProps): JSX.Element;
