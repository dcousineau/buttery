import * as React from "react";

/**
 * Centered modal on a card surface — the ONE place in Buttery where a backdrop
 * blur is sanctioned (2px, behind a 20% black scrim). Dialog titles are the only
 * display-font moment inside a modal.
 */
export interface DialogProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "size"> {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * `sm`/`default`/`lg`/`xl` are centred modals at 22/28/40/56rem. `fullscreen`
   * drops the scrim, border and radius and takes the whole viewport — that is the
   * cook-mode shape (48px+ controls, 3rem display title).
   */
  size?: "sm" | "default" | "lg" | "xl" | "fullscreen";
  className?: string;
  children?: React.ReactNode;
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Uses the destructive button variant for the confirm action. */
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
}

export declare function Dialog(props: DialogProps): JSX.Element | null;
export declare function DialogTitle(props: React.HTMLAttributes<HTMLHeadingElement>): JSX.Element;
export declare function DialogDescription(props: React.HTMLAttributes<HTMLParagraphElement>): JSX.Element;
export declare function DialogActions(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export declare function ConfirmDialog(props: ConfirmDialogProps): JSX.Element;
