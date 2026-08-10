import * as React from "react";

/**
 * The form-composition layer: `FieldGroup` stacks fields at 1.25rem, `Field`
 * pairs a label with its control, and `data-invalid` on the Field tints the
 * whole group destructive. `data-warning` is the softer, advisory version of
 * the same thing — invalid outranks it.
 */
export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "vertical" | "horizontal";
  /** Set to `true` to tint the label and helper text destructive. */
  "data-invalid"?: boolean;
  /** Set to `true` to tint the label and helper text warning. Ignored when `data-invalid` is set. */
  "data-warning"?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export declare function FieldGroup(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function Field(props: FieldProps): JSX.Element;
export declare function FieldLabel(props: React.LabelHTMLAttributes<HTMLLabelElement>): JSX.Element;
export declare function FieldContent(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function FieldDescription(props: React.HTMLAttributes<HTMLParagraphElement>): JSX.Element;
export declare function FieldError(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
/**
 * Advisory sibling of `FieldError`: a ⚠︎ and amber copy the user may ignore.
 * No `role="alert"` — a note in the margin doesn't get to interrupt.
 */
export declare function FieldWarning(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function FieldSet(props: React.FieldsetHTMLAttributes<HTMLFieldSetElement>): JSX.Element;
export declare function FieldLegend(props: React.HTMLAttributes<HTMLLegendElement>): JSX.Element;
