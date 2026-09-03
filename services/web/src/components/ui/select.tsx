import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "#/lib/utils.ts";

/*
 * Styled native <select>. Buttery has no popover Select and doesn't need one —
 * the invite form already styles a raw <select> inline (routes/households.index.tsx);
 * this promotes that exact treatment into a primitive so it isn't re-styled per
 * screen. Heights come from the shared control scale (BRAND.md), so a Select lines
 * up with a Button, Badge and Input of the same `size`.
 *
 * The chevron is the Lucide `chevron-down` path as a background image, tinted per
 * theme, so the native OS arrow never appears.
 */

const CHEVRON_LIGHT =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%232a1e12' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>\")";
const CHEVRON_DARK =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23fff4da' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>\")";

/* Red `aria-invalid` blocks, amber `data-warning="true"` advises — see Input for the
 * full note on why the two must not look alike. */
const selectVariants = cva(
  "w-full min-w-0 appearance-none rounded-lg border-2 border-input bg-card bg-no-repeat transition-[box-shadow,border-color] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:shadow-pop disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[warning=true]:not-aria-invalid:border-warning data-[warning=true]:not-aria-invalid:ring-3 data-[warning=true]:not-aria-invalid:ring-warning/25",
  {
    variants: {
      size: {
        xs: "h-(--control-h-xs) bg-[position:right_6px_center] bg-[size:12px] pr-6 pl-(--control-px-xs) text-xs",
        sm: "h-(--control-h-sm) bg-[position:right_8px_center] bg-[size:14px] pr-7 pl-(--control-px-sm) text-sm",
        default: "h-(--control-h) bg-[position:right_10px_center] bg-[size:15px] pr-8 pl-(--control-px) text-sm",
        lg: "h-(--control-h-lg) bg-[position:right_10px_center] bg-[size:16px] pr-9 pl-(--control-px-lg) text-base",
        xl: "h-(--control-h-xl) rounded-xl bg-[position:right_16px_center] bg-[size:20px] pr-12 pl-5 text-lg",
        "2xl": "h-(--control-h-2xl) rounded-xl bg-[position:right_20px_center] bg-[size:26px] pr-16 pl-7 text-2xl",
      },
    },
    defaultVariants: { size: "default" },
  },
);

function Select({ className, size = "default", style, ...props }: Omit<React.ComponentProps<"select">, "size"> & VariantProps<typeof selectVariants>) {
  return (
    <select
      data-slot="select"
      className={cn(selectVariants({ size }), "[background-image:var(--select-chevron)] dark:[--select-chevron:var(--select-chevron-dark)]", className)}
      style={{ ["--select-chevron" as string]: CHEVRON_LIGHT, ["--select-chevron-dark" as string]: CHEVRON_DARK, ...style }}
      {...props}
    />
  );
}

export { Select, selectVariants };
