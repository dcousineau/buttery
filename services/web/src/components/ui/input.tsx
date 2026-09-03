import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "#/lib/utils.ts";

/**
 * Three problem states, not two.
 *
 * `aria-invalid` is the blocking one: red, announced as invalid, "this will not save".
 * `data-warning="true"` is the advisory one: amber, announced as nothing at all, "you
 * may want to look at this, and it is fine if you don't" — an unparsed ingredient
 * amount, a step that mentions a time we couldn't read. Painting those red taught
 * people to ignore red, which is the one thing red cannot afford.
 *
 * A control should carry at most one of the two, but if a call site sets both, invalid
 * wins by construction (`not-aria-invalid`) rather than by class order. Warning is a
 * *visual* state only: it deliberately sets no ARIA, because `aria-invalid` on
 * something that saves fine is a lie to a screen reader. Pair it with a `FieldWarning`
 * (components/ui/field.tsx) for the words.
 */
const inputVariants = cva(
  "w-full min-w-0 rounded-lg border-2 border-input bg-card transition-[box-shadow,border-color] outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:shadow-pop disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[warning=true]:not-aria-invalid:border-warning data-[warning=true]:not-aria-invalid:ring-3 data-[warning=true]:not-aria-invalid:ring-warning/25 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
  {
    variants: {
      size: {
        xs: "h-(--control-h-xs) px-(--control-px-xs) text-xs",
        sm: "h-(--control-h-sm) px-(--control-px-sm) text-sm",
        default: "h-(--control-h) px-(--control-px) text-base md:text-sm",
        lg: "h-(--control-h-lg) px-(--control-px-lg) text-base md:text-sm",
        xl: "h-(--control-h-xl) rounded-xl px-5 text-lg",
        "2xl": "h-(--control-h-2xl) rounded-xl px-7 text-2xl",
      },
    },
    defaultVariants: { size: "default" },
  },
);

function Input({ className, type, size = "default", ...props }: Omit<React.ComponentProps<"input">, "size"> & VariantProps<typeof inputVariants>) {
  return <InputPrimitive type={type} data-slot="input" className={cn(inputVariants({ size }), className)} {...props} />;
}

export { Input, inputVariants };
