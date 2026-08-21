import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "#/components/ui/dialog.tsx";
import { Button } from "#/components/ui/button";
import type { ReactNode } from "react";

/**
 * A minimal centered confirm dialog built on the shared `ui/dialog.tsx` primitive.
 * Controlled via `open`/`onOpenChange`. Used for the §5 guardrail-4 "you're already
 * in a household" second-create confirm (acceptance item 11), and reused for
 * destructive management actions.
 *
 * Two optional slots, both added for the collections publish dialogs and both
 * inert when omitted:
 *
 * - **`children`** render between the description and the footer. `description`
 *   is a `<p>` (`DialogDescription`), so anything with block structure — a list
 *   of the recipes blocking a publish, a failure notice the dialog stays open
 *   to show — has to live outside it rather than inside.
 * - **`touch`** makes the footer buttons 44px and full-width, for a dialog
 *   opened from a phone sheet, where the collections surfaces set that floor
 *   explicitly (collections plan §7).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  pending = false,
  touch = false,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  /** 44px, full-width footer buttons — for a dialog opened over a mobile sheet. */
  touch?: boolean;
  onConfirm: () => void;
  /** Extra body content, between the description and the footer. */
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        {children}
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" disabled={pending} className={touch ? "h-11 flex-1" : undefined} />}>{cancelLabel}</DialogClose>
          <Button variant={destructive ? "destructive" : "default"} disabled={pending} className={touch ? "h-11 flex-1" : undefined} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
