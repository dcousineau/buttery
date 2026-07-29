import * as React from "react";

type ControlSize = "xs" | "sm" | "default" | "lg" | "xl" | "2xl";

/**
 * Text input: 2px ink border, and — the signature detail — focus grows a 3px ring
 * AND a 3px hard offset shadow, so a focused field looks physically lifted off
 * the card. Heights come from the SHARED control scale, so an Input, Button,
 * Badge and Select at the same `size` are identical heights.
 */
export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** 24 / 28 / 32 / 36 / 48 / 64px. `xl`/`2xl` are the cook-mode steps. */
  size?: ControlSize;
  className?: string;
}

/** Styled native `<select>` with the ink chevron. Buttery has no popover Select. */
export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  size?: ControlSize;
  className?: string;
}

/** Multi-line input — recipe notes, instruction steps, invite messages. */
export interface TextareaProps extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "size"> {
  size?: "default" | "lg" | "xl" | "2xl";
  rows?: number;
  className?: string;
}

export declare function Input(props: InputProps): JSX.Element;
export declare function Select(props: SelectProps): JSX.Element;
/** Alias for `Select`, kept because the source calls it a native select. */
export declare function NativeSelect(props: SelectProps): JSX.Element;
export declare function Textarea(props: TextareaProps): JSX.Element;
