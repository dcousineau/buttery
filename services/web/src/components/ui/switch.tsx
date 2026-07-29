import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "#/lib/utils.ts";

/*
 * Neo-brutalist switch (BRAND.md): ink-bordered track that fills butter when on,
 * ink knob, hard offset shadow. Real track + knob elements over a hidden native
 * input (see checkbox.tsx for why).
 *
 * Use for PERSISTENT SETTINGS only ("keep the screen awake", "hide non-vegetarian
 * recipes"). An action is a Button, never a Switch.
 */

const trackVariants = cva(
  "flex shrink-0 items-center rounded-4xl border-2 border-border bg-card shadow-pop-sm transition-all peer-checked:bg-secondary peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring",
  {
    variants: {
      size: {
        sm: "h-5 w-8 px-0.5 peer-checked:[&>span]:translate-x-3",
        default: "h-6 w-11 px-0.5 peer-checked:[&>span]:translate-x-5",
        lg: "h-8 w-14 px-[3px] peer-checked:[&>span]:translate-x-6",
        // Cook mode: 80×44px — a real target for a floury thumb.
        xl: "h-11 w-20 px-1 shadow-pop peer-checked:[&>span]:translate-x-9",
      },
    },
    defaultVariants: { size: "default" },
  },
);

const knobVariants = cva("rounded-full bg-border transition-transform", {
  variants: {
    size: { sm: "size-3", default: "size-4", lg: "size-[22px]", xl: "size-8" },
  },
  defaultVariants: { size: "default" },
});

function Switch({ className, size = "default", ...props }: Omit<React.ComponentProps<"input">, "size" | "type"> & VariantProps<typeof trackVariants>) {
  return (
    <span data-slot="switch" className={cn("relative inline-flex shrink-0 align-middle", props.disabled && "opacity-50", className)}>
      <input type="checkbox" role="switch" className="peer absolute inset-0 size-full cursor-(--cursor-interactive) opacity-0 disabled:cursor-not-allowed" {...props} />
      <span className={cn(trackVariants({ size }))}>
        <span className={cn(knobVariants({ size }))} />
      </span>
    </span>
  );
}

export { Switch, trackVariants as switchTrackVariants };
