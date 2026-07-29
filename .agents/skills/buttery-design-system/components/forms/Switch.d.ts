import * as React from "react";

/**
 * Ink-bordered track that fills butter when on. Use for persistent settings
 * ("keep screen awake", "hide non-vegetarian recipes"), never for an action —
 * an action is a Button. `size="xl"` (80×44px) is the cook-mode step.
 */
export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: "sm" | "default" | "lg" | "xl";
  className?: string;
}

export declare function Switch(props: SwitchProps): JSX.Element;
