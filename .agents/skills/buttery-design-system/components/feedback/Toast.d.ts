import * as React from "react";

/**
 * Transient confirmation on a card surface with a 4px hard shadow. Buttery uses
 * toasts for reversible successes ("Invite link copied", "Added to the shopping
 * list") — never for validation, which lives inline next to the field.
 */
export interface ToastProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** `success` fills butter, `destructive` fills red. `default` is paper. */
  variant?: "default" | "success" | "destructive";
  /** `xl` is the cook-mode step — readable across a kitchen. */
  size?: "default" | "xl";
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Render a dismiss button when provided. */
  onClose?: () => void;
  className?: string;
}

export interface ToastViewportProps extends React.HTMLAttributes<HTMLDivElement> {
  position?: "bottom-right" | "bottom-center" | "top-right";
  className?: string;
}

export interface ToastQueueItem {
  id: string;
  variant?: "default" | "success" | "destructive";
  title?: React.ReactNode;
  description?: React.ReactNode;
}

export declare function ToastViewport(props: ToastViewportProps): JSX.Element;
export declare function Toast(props: ToastProps): JSX.Element;
/** Tiny queue helper — auto-dismisses after `timeout` ms (0 disables). */
export declare function useToasts(timeout?: number): {
  toasts: ToastQueueItem[];
  push: (toast: Omit<ToastQueueItem, "id">) => string;
  dismiss: (id: string) => void;
};
