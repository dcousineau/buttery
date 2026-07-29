import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "#/lib/utils.ts";

const inputVariants = cva(
  "w-full min-w-0 rounded-lg border-2 border-input bg-card transition-[box-shadow,border-color] outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:shadow-pop disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
  {
    variants: {
      size: {
        xs: "h-6 px-2 text-xs",
        sm: "h-7 px-2.5 text-sm",
        default: "h-8 px-3 text-base md:text-sm",
        lg: "h-9 px-3.5 text-base md:text-sm",
        xl: "h-12 rounded-xl px-5 text-lg",
        "2xl": "h-16 rounded-xl px-7 text-2xl",
      },
    },
    defaultVariants: { size: "default" },
  },
);

function Input({ className, type, size = "default", ...props }: Omit<React.ComponentProps<"input">, "size"> & VariantProps<typeof inputVariants>) {
  return <InputPrimitive type={type} data-slot="input" className={cn(inputVariants({ size }), className)} {...props} />;
}

export { Input, inputVariants };
