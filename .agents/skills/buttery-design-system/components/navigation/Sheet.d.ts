import * as React from "react";

/**
 * Edge-anchored slide-in panel. In Buttery it exists to host the mobile
 * navigation drawer (Sidebar switches to a left-side Sheet below 768px). Note it
 * carries a 2px border only on its inner edge and NO offset shadow.
 */
export interface SheetProps extends React.HTMLAttributes<HTMLDivElement> {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
  children?: React.ReactNode;
}

export declare function Sheet(props: SheetProps): JSX.Element | null;
export declare function SheetHeader(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function SheetFooter(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function SheetTitle(props: React.HTMLAttributes<HTMLHeadingElement>): JSX.Element;
export declare function SheetDescription(props: React.HTMLAttributes<HTMLParagraphElement>): JSX.Element;
