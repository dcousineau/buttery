import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "#/lib/utils.ts";

const progressVariants = cva("w-full overflow-hidden rounded-full bg-muted", {
  variants: {
    size: {
      // Shared size scale. `default` is the bar TimerRow has always drawn.
      sm: "h-1",
      default: "h-1.5",
      lg: "h-2.5",
    },
  },
  defaultVariants: {
    size: "default",
  },
});

const progressFillVariants = cva("h-full rounded-full", {
  variants: {
    variant: {
      default: "bg-primary",
      secondary: "bg-secondary",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

type ProgressProps = Omit<React.ComponentProps<"div">, "children"> &
  VariantProps<typeof progressVariants> &
  VariantProps<typeof progressFillVariants> & {
    /** Work done, in `max` units. `null`/omitted renders the indeterminate state — the
     *  "reading your recipe box…" phase, before a total is known. */
    value?: number | null;
    /** Defaults to 100 (percent). A non-finite or non-positive `max` falls back to 100
     *  rather than dividing by zero and rendering `NaN%`. */
    max?: number;
    /** `aria-valuetext` — the human string a screen reader reads instead of the bare
     *  number: "128 of 341 read", "Saving 40 of 305". Required by the plan's
     *  accessibility floor (§10.4); falls back to a percentage (or "In progress" when
     *  indeterminate) so a bar is never silent, but callers should pass the real one.
     *
     *  This is NOT the accessible *name* — pass `aria-label` or `aria-labelledby` for
     *  that, and throttle any `aria-live` region announcing progress to chunk
     *  boundaries rather than every tick (§10.4). */
    label?: string;
  };

/**
 * The one progress bar (paprika-import plan §10). Reading, committing, and the
 * duplicate queue all use this rather than hand-rolling a `div` with a percentage
 * width, so `role="progressbar"` semantics exist everywhere by construction.
 */
function Progress({ value, max = 100, label, size, variant, className, ...props }: ProgressProps) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
  const indeterminate = value == null || !Number.isFinite(value);
  const clamped = indeterminate ? null : Math.min(Math.max(value as number, 0), safeMax);
  const percent = clamped === null ? 0 : (clamped / safeMax) * 100;
  // ARIA: an indeterminate bar omits `aria-valuenow` entirely — it must not claim 0.
  const valueText = label ?? (indeterminate ? "In progress" : `${Math.round(percent)}%`);

  return (
    <div
      data-slot="progress"
      data-state={indeterminate ? "indeterminate" : "determinate"}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={clamped ?? undefined}
      aria-valuetext={valueText}
      className={cn(progressVariants({ size }), className)}
      {...props}
    >
      <div
        data-slot="progress-fill"
        className={cn(
          progressFillVariants({ variant }),
          // Indeterminate: a third-width sliver sweeping the track. Under reduced
          // motion it degrades to a static, dimmed full-width fill — a parked sliver
          // would read as "33% done", which is a lie.
          indeterminate ? "w-1/3 motion-safe:animate-progress-indeterminate motion-reduce:w-full motion-reduce:opacity-70" : "transition-[width] duration-500",
        )}
        style={indeterminate ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}

export { Progress, progressVariants, progressFillVariants };
