import * as React from "react";

/**
 * The form-composition layer: `FieldGroup` stacks fields at 1.25rem, `Field`
 * pairs a label with its control, and `data-invalid` on the Field tints the
 * whole group destructive.
 */
export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "vertical" | "horizontal";
  /** Set to `true` to tint the label and helper text destructive. */
  "data-invalid"?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export declare function FieldGroup(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function Field(props: FieldProps): JSX.Element;
export declare function FieldLabel(props: React.LabelHTMLAttributes<HTMLLabelElement>): JSX.Element;
export declare function FieldContent(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function FieldDescription(props: React.HTMLAttributes<HTMLParagraphElement>): JSX.Element;
export declare function FieldError(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function FieldSet(props: React.FieldsetHTMLAttributes<HTMLFieldSetElement>): JSX.Element;
export declare function FieldLegend(props: React.HTMLAttributes<HTMLLegendElement>): JSX.Element;
