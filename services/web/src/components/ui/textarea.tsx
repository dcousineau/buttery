import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "#/lib/utils.ts";

/*
 * Multi-line input. Same construction as Input: 2px ink border, and on focus a
 * 3px ring PLUS a hard offset shadow so the field looks physically lifted.
 * Vertical resize only — horizontal resize breaks the content column.
 *
 * Two problem states, and they are not the same news (see Input for the full note):
 * `aria-invalid` is red and blocking, `data-warning="true"` is amber and advisory.
 *
 * `autosize` grows the field with its content, no JS, no resize listeners: CSS
 * `field-sizing: content`. The catch is that `field-sizing: content` makes the
 * browser ignore `rows` for sizing — an empty rows={8} box collapses to one line
 * — so we re-establish the same height as a floor with `min-height`, computed
 * from the row count in `1lh` (the element's own line-height) plus the padding
 * and border, since the box is border-box. `--textarea-rows` comes in inline
 * from the `rows` prop; `--textarea-py` is set beside the padding in each size
 * (override the padding from a caller's `className` and you owe the var too).
 * The arithmetic is exact: rows*1lh + 2*py + 4px is byte-for-byte the height the
 * `rows` attribute would have produced.
 *
 * Browsers without `field-sizing` (Firefox, as of today) simply keep today's
 * behavior: `rows` sizes the box, `min-height` resolves to the identical value,
 * the field scrolls. Nothing to polyfill, and no JS fallback.
 *
 * Resize handle: a drag writes an inline `height`, which outranks content
 * sizing and permanently freezes the box — the auto-growth would silently stop
 * working. Since an auto-sized field never hides content there is nothing for a
 * drag to reveal, so we drop the handle exactly where auto-sizing works and keep
 * it where it doesn't. Callers wanting a ceiling can pass `max-h-*`; the field
 * scrolls past it as normal.
 */
const textareaVariants = cva(
  "w-full min-w-0 resize-y rounded-lg border-2 border-input bg-card leading-normal transition-[box-shadow,border-color] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:shadow-pop disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[warning=true]:not-aria-invalid:border-warning data-[warning=true]:not-aria-invalid:ring-3 data-[warning=true]:not-aria-invalid:ring-warning/25 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
  {
    variants: {
      size: {
        default: "px-3 py-2 text-base md:text-sm [--textarea-py:--spacing(2)]",
        lg: "px-3.5 py-2.5 text-base [--textarea-py:--spacing(2.5)]",
        xl: "rounded-xl px-5 py-3.5 text-lg [--textarea-py:--spacing(3.5)]",
        "2xl": "rounded-xl px-7 py-4 text-2xl [--textarea-py:--spacing(4)]",
      },
      autosize: {
        true: "field-sizing-content min-h-[calc(var(--textarea-rows,2)*1lh_+_var(--textarea-py)*2_+_4px)] supports-[field-sizing:content]:resize-none",
        false: "",
      },
    },
    defaultVariants: { size: "default", autosize: false },
  },
);

function Textarea({
  className,
  size = "default",
  autosize = false,
  rows = 4,
  style,
  ...props
}: Omit<React.ComponentProps<"textarea">, "size"> & VariantProps<typeof textareaVariants>) {
  // `rows` stays on the element either way: it is what sizes the field in
  // browsers without `field-sizing`, and what feeds the min-height floor here.
  return (
    <textarea
      data-slot="textarea"
      rows={rows}
      style={autosize ? ({ "--textarea-rows": rows, ...style } as React.CSSProperties) : style}
      className={cn(textareaVariants({ size, autosize }), className)}
      {...props}
    />
  );
}

export { Textarea, textareaVariants };
