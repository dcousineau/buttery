import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { XIcon } from "lucide-react";

import { cn } from "#/lib/utils.ts";

/*
 * Neo-brutalist toast (BRAND.md): card surface, 2px ink border, 4px hard shadow,
 * entering with the same rise-in easing as page content.
 *
 * SCOPE RULE: toasts are for reversible SUCCESSES ("Invite link copied", "Added to
 * the shopping list"). Form validation stays inline next to the field as a
 * role="alert" paragraph — do not move it into a toast.
 *
 * Sits at z-60, above dialogs (z-50), so a confirmation is never buried.
 */

const toastVariants = cva("pointer-events-auto flex items-start gap-2.5 border-2 border-border shadow-pop-md motion-safe:animate-[rise-in_150ms_cubic-bezier(0.16,1,0.3,1)_both]", {
  variants: {
    variant: {
      default: "bg-card text-card-foreground",
      success: "bg-secondary text-secondary-foreground",
      destructive: "bg-destructive text-primary-foreground",
    },
    size: {
      default: "rounded-lg px-3.5 py-3 text-sm",
      // Cook mode: legible from the counter.
      xl: "rounded-xl px-5 py-4.5 text-xl shadow-pop-lg",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

function ToastViewport({ className, position = "bottom-right", ...props }: React.ComponentProps<"div"> & { position?: "bottom-right" | "bottom-center" | "top-right" }) {
  return (
    <div
      data-slot="toast-viewport"
      data-position={position}
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed z-[60] flex w-[min(24rem,100vw)] flex-col gap-2 p-4",
        position === "bottom-right" && "right-0 bottom-0",
        position === "bottom-center" && "bottom-0 left-1/2 -translate-x-1/2",
        position === "top-right" && "top-0 right-0",
        className,
      )}
      {...props}
    />
  );
}

function Toast({
  className,
  variant = "default",
  size = "default",
  title,
  description,
  onClose,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> &
  VariantProps<typeof toastVariants> & {
    title?: React.ReactNode;
    description?: React.ReactNode;
    onClose?: () => void;
  }) {
  // No role="status" here: the enclosing <ToastViewport> is the single
  // aria-live region, so announcing on both would double-read in some SRs.
  return (
    <div data-slot="toast" className={cn(toastVariants({ variant, size }), className)} {...props}>
      {children}
      <div className="min-w-0 flex-1">
        {title ? <div className="leading-snug font-semibold">{title}</div> : null}
        {description ? <p className={cn("m-0 mt-0.5 text-sm", variant === "default" ? "text-muted-foreground" : "opacity-85")}>{description}</p> : null}
      </div>
      {onClose ? (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onClose}
          className="grid size-5 shrink-0 cursor-(--cursor-interactive) place-content-center rounded-sm text-inherit opacity-60 hover:opacity-100"
        >
          <XIcon className="size-3.5" strokeWidth={2.5} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

type ToastQueueItem = {
  id: string;
  variant?: "default" | "success" | "destructive";
  title?: React.ReactNode;
  description?: React.ReactNode;
};

/**
 * Minimal queue. No provider, no portal, no new dependency — mount one
 * <ToastViewport> in the layout that needs it and map the queue into it.
 * Pass `timeout = 0` to require an explicit dismiss.
 *
 * `pauseAll`/`resumeAll` let a caller freeze the auto-dismiss countdown while the
 * viewport is hovered or focused (WCAG 2.2.1) — remaining time is preserved and
 * resumed, so a toast never disappears out from under a pointer or keyboard user.
 */
function useToasts(timeout = 4000) {
  const [toasts, setToasts] = React.useState<ToastQueueItem[]>([]);
  const timers = React.useRef(new Map<string, { handle: ReturnType<typeof setTimeout> | null; remaining: number; startedAt: number }>());

  const dismiss = React.useCallback((id: string) => {
    const rec = timers.current.get(id);
    if (rec?.handle) clearTimeout(rec.handle);
    timers.current.delete(id);
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = React.useCallback(
    (toast: Omit<ToastQueueItem, "id">) => {
      const id = crypto.randomUUID();
      setToasts((t) => [...t, { ...toast, id }]);
      if (timeout) {
        timers.current.set(id, { handle: setTimeout(() => dismiss(id), timeout), remaining: timeout, startedAt: Date.now() });
      }
      return id;
    },
    [dismiss, timeout],
  );

  const pauseAll = React.useCallback(() => {
    for (const [id, rec] of timers.current) {
      if (rec.handle) {
        clearTimeout(rec.handle);
        timers.current.set(id, { handle: null, remaining: Math.max(0, rec.remaining - (Date.now() - rec.startedAt)), startedAt: rec.startedAt });
      }
    }
  }, []);

  const resumeAll = React.useCallback(() => {
    for (const [id, rec] of timers.current) {
      if (!rec.handle && rec.remaining > 0) {
        timers.current.set(id, { handle: setTimeout(() => dismiss(id), rec.remaining), remaining: rec.remaining, startedAt: Date.now() });
      }
    }
  }, [dismiss]);

  React.useEffect(() => {
    const map = timers.current;
    return () => {
      for (const rec of map.values()) if (rec.handle) clearTimeout(rec.handle);
    };
  }, []);

  return { toasts, push, dismiss, pauseAll, resumeAll };
}

export { Toast, ToastViewport, useToasts, toastVariants };
export type { ToastQueueItem };
