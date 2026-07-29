import * as React from "react";

/**
 * Radio + selectable radio card. Buttery's existing invite form uses bare native
 * radios; these are the styled equivalents, with the same four size steps as
 * Checkbox so a cook-mode or kiosk surface can use `xl`.
 */
export interface RadioProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: "sm" | "default" | "lg" | "xl";
  className?: string;
}

export interface RadioGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "vertical" | "horizontal";
  className?: string;
}

/** A pick-one card that fills butter when selected. Use for diets, portion sizes, invite modes. */
export interface RadioCardProps extends Omit<React.LabelHTMLAttributes<HTMLLabelElement>, "size" | "title"> {
  size?: "sm" | "default" | "lg" | "xl";
  checked?: boolean;
  name?: string;
  value?: string;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  title: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
}

export declare function RadioGroup(props: RadioGroupProps): JSX.Element;
export declare function Radio(props: RadioProps): JSX.Element;
export declare function RadioCard(props: RadioCardProps): JSX.Element;
