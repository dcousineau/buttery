import { Dialog } from "@base-ui/react/dialog";
import { Button } from "#/components/ui/button";
import type { ReactNode } from "react";

/**
 * A minimal centered confirm dialog built on the same base-ui `Dialog` primitive
 * as `ui/sheet.tsx` (so no new dependency). Controlled via `open`/`onOpenChange`.
 * Used for the §5 guardrail-4 "you're already in a household" second-create
 * confirm (acceptance item 11), and reused for destructive management actions.
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
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/20 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 flex w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-xl border-2 border-border bg-card p-5 text-card-foreground shadow-pop-md transition duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
          <Dialog.Title className="display-title text-lg text-foreground">{title}</Dialog.Title>
          <Dialog.Description className="m-0 text-sm text-muted-foreground">{description}</Dialog.Description>
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <Dialog.Close render={<Button variant="ghost" disabled={pending} />}>{cancelLabel}</Dialog.Close>
            <Button variant={destructive ? "destructive" : "default"} disabled={pending} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
