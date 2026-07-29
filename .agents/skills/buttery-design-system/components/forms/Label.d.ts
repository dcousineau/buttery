import * as React from "react";

/** Rubik 500 at 14px, flex row with a 0.5rem gap so an icon can sit beside the text. */
export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  className?: string;
  children?: React.ReactNode;
}

export declare function Label(props: LabelProps): JSX.Element;
