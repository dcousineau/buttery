import * as React from "react";

/**
 * The surface primitive: paper fill, 2px ink border, 12px+4px radius, and a 4px
 * hard offset shadow. Every content block in Buttery sits in one of these.
 */
export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Internal spacing step: `sm` 0.75rem · `default` 1rem · `lg` 1.5rem ·
   * `xl` 2rem (cook mode — also bumps the title to 1.5rem and the shadow to 6px).
   */
  size?: "sm" | "default" | "lg" | "xl";
  className?: string;
  children?: React.ReactNode;
}

export declare function Card(props: CardProps): JSX.Element;
export declare function CardHeader(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function CardTitle(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function CardDescription(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function CardAction(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function CardContent(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function CardFooter(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
