import { ScanLine } from "lucide-react";
import { Spinner } from "#/components/ui/spinner.tsx";
import { cn } from "#/lib/utils.ts";

/**
 * The scanner's stand-in while it cannot be a scanner yet: during SSR and the
 * first client render (so hydration matches), and while the scanner's code is
 * downloading. Same box as the live preview, so nothing shifts when it swaps in.
 */
export function ScannerPlaceholder({ label, className }: { label: string; className?: string }) {
  return (
    <div
      data-slot="scanner-placeholder"
      className={cn("flex aspect-3/4 w-full flex-col items-center justify-center gap-3 rounded-xl border-2 border-border bg-muted p-6 text-center shadow-pop-md", className)}
    >
      <ScanLine className="size-10 text-muted-foreground" aria-hidden="true" />
      <p className="m-0 flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Spinner className="size-4" aria-hidden="true" role="presentation" />
        {label}
      </p>
    </div>
  );
}
