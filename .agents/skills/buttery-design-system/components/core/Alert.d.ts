import * as React from "react";

/**
 * Inline notice on a card surface. Note the deliberate exception: Alert uses a
 * 1px border and NO offset shadow — it is the quietest bordered element in the
 * system, so it never competes with the card it sits inside.
 */
export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "destructive";
  className?: string;
  children?: React.ReactNode;
}

export declare function Alert(props: AlertProps): JSX.Element;
export declare function AlertTitle(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function AlertDescription(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function AlertAction(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
