import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "#/lib/utils.ts";

const dialogPopupVariants = cva(
  "fixed z-(--z-modal) flex flex-col gap-3 bg-card text-card-foreground transition duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0",
  {
    variants: {
      size: {
        sm: "top-1/2 left-1/2 w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border-2 border-border p-5 shadow-pop-md data-ending-style:scale-95 data-starting-style:scale-95",
        default:
          "top-1/2 left-1/2 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border-2 border-border p-5 shadow-pop-md data-ending-style:scale-95 data-starting-style:scale-95",
        lg: "top-1/2 left-1/2 w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border-2 border-border p-6 shadow-pop-md data-ending-style:scale-95 data-starting-style:scale-95",
        xl: "top-1/2 left-1/2 w-[calc(100vw-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 gap-5 rounded-xl border-2 border-border p-8 shadow-pop-md data-ending-style:scale-95 data-starting-style:scale-95",
        // Cook mode: the recipe owns the screen. No scrim, no border, no radius.
        fullscreen: "inset-0 h-svh w-screen gap-6 overflow-auto bg-background p-8",
      },
    },
    defaultVariants: { size: "default" },
  },
);

const dialogTitleVariants = cva("display-title m-0 text-foreground", {
  variants: {
    size: { sm: "text-lg", default: "text-lg", lg: "text-xl", xl: "text-2xl", fullscreen: "text-4xl leading-[1.08] sm:text-5xl" },
  },
  defaultVariants: { size: "default" },
});

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/** The one sanctioned backdrop-blur in the app (BRAND.md). Omitted at fullscreen. */
function DialogBackdrop({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-backdrop"
      className={cn(
        "fixed inset-0 z-(--z-modal) bg-black/20 transition-opacity duration-150 supports-backdrop-filter:backdrop-blur-xs data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({ className, size = "default", children, ...props }: DialogPrimitive.Popup.Props & VariantProps<typeof dialogPopupVariants>) {
  return (
    <DialogPrimitive.Portal>
      {size === "fullscreen" ? null : <DialogBackdrop />}
      <DialogPrimitive.Popup data-slot="dialog-content" data-size={size} className={cn(dialogPopupVariants({ size }), className)} {...props}>
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

function DialogTitle({ className, size = "default", ...props }: DialogPrimitive.Title.Props & VariantProps<typeof dialogTitleVariants>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn(dialogTitleVariants({ size }), className)} {...props} />;
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn("m-0 text-sm text-muted-foreground", className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-footer" className={cn("mt-2 flex flex-wrap justify-end gap-2 touch:gap-(--touch-gap)", className)} {...props} />;
}

export { Dialog, DialogTrigger, DialogClose, DialogBackdrop, DialogContent, DialogTitle, DialogDescription, DialogFooter, dialogPopupVariants };
