import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "#/components/ui/dialog.tsx";
import { Button } from "#/components/ui/button";
import type { ReactNode } from "react";

/**
 * A minimal centered confirm dialog built on the shared `ui/dialog.tsx` primitive.
 * Controlled via `open`/`onOpenChange`. Used for the §5 guardrail-4 "you're already
 * in a household" second-create confirm (acceptance item 11), and reused for
 * destructive management actions.
 *
 * `children` render between the description and the footer. `description` is a
 * `<p>` (`DialogDescription`), so anything with block structure — a list of the
 * recipes blocking a publish, a failure notice the dialog stays open to show —
 * has to live outside it rather than inside.
 *
 * The footer is thumb-sized on a coarse pointer WITHOUT being asked: this used to
 * be a `touch` boolean each caller threaded down from its own `useIsMobile()`, so
 * a confirm reached from a phone sheet got 44px buttons and the identical confirm
 * reached from anywhere else did not. The two `touch:` classes below say it once,
 * for every caller, and are right even when the dialog is opened on a phone from
 * a surface that never thought about phones.
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
          {/* Side by side on a cursor, half the sheet each on a thumb: `flex-1`
              turns two 44px buttons into two targets you cannot miss, and
              `--control-h-lg` is 48px on a coarse pointer, so the pair that
              decides something irreversible sits a step above the floor. */}
          <DialogClose render={<Button variant="ghost" disabled={pending} className="touch:h-(--control-h-lg) touch:flex-1" />}>{cancelLabel}</DialogClose>
          <Button variant={destructive ? "destructive" : "default"} disabled={pending} className="touch:h-(--control-h-lg) touch:flex-1" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
