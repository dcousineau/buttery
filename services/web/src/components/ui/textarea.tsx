import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "#/lib/utils.ts";

/*
 * Multi-line input. Same construction as Input: 2px ink border, and on focus a
 * 3px ring PLUS a hard offset shadow so the field looks physically lifted.
 * Vertical resize only — horizontal resize breaks the content column.
 */
const textareaVariants = cva(
  "w-full min-w-0 resize-y rounded-lg border-2 border-input bg-card leading-normal transition-[box-shadow,border-color] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:shadow-pop disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
  {
    variants: {
      size: {
        default: "px-3 py-2 text-base md:text-sm",
        lg: "px-3.5 py-2.5 text-base",
        xl: "rounded-xl px-5 py-3.5 text-lg",
        "2xl": "rounded-xl px-7 py-4 text-2xl",
      },
    },
    defaultVariants: { size: "default" },
  },
);

function Textarea({ className, size = "default", rows = 4, ...props }: Omit<React.ComponentProps<"textarea">, "size"> & VariantProps<typeof textareaVariants>) {
  return <textarea data-slot="textarea" rows={rows} className={cn(textareaVariants({ size }), className)} {...props} />;
}

export { Textarea, textareaVariants };
