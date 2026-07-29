import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "#/lib/utils.ts";

/*
 * Neo-brutalist radio (BRAND.md). Same construction as Checkbox — real box + dot
 * over a visually-hidden native input, so the control survives DOM-rasterised
 * capture. Circular at every size: the round shape is what says "choose one",
 * against the checkbox's deliberately square small corners.
 */

const radioVariants = cva(
  "flex shrink-0 items-center justify-center rounded-full border-2 border-border bg-card shadow-pop-sm transition-all peer-checked:bg-secondary peer-active:translate-x-px peer-active:translate-y-px peer-active:shadow-none peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-checked:[&>span]:scale-100 peer-checked:[&>span]:opacity-100",
  {
    variants: {
      size: { sm: "size-4", default: "size-5", lg: "size-7", xl: "size-10 shadow-pop" },
    },
    defaultVariants: { size: "default" },
  },
);

const dotVariants = cva("scale-40 rounded-full bg-secondary-foreground opacity-0 transition-all", {
  variants: {
    size: { sm: "size-[7px]", default: "size-[9px]", lg: "size-[13px]", xl: "size-[19px]" },
  },
  defaultVariants: { size: "default" },
});

function RadioGroup({ className, orientation = "vertical", ...props }: React.ComponentProps<"div"> & { orientation?: "vertical" | "horizontal" }) {
  return (
    <div
      role="radiogroup"
      data-slot="radio-group"
      data-orientation={orientation}
      className={cn(
        "flex data-[orientation=vertical]:flex-col data-[orientation=vertical]:gap-2 data-[orientation=horizontal]:flex-row data-[orientation=horizontal]:flex-wrap data-[orientation=horizontal]:items-center data-[orientation=horizontal]:gap-4",
        className,
      )}
      {...props}
    />
  );
}

function Radio({ className, size = "default", ...props }: Omit<React.ComponentProps<"input">, "size" | "type"> & VariantProps<typeof radioVariants>) {
  return (
    <span data-slot="radio" className={cn("relative inline-flex shrink-0 align-middle", props.disabled && "opacity-50", className)}>
      <input type="radio" className="peer absolute inset-0 size-full cursor-(--cursor-interactive) opacity-0 disabled:cursor-not-allowed" {...props} />
      <span className={cn(radioVariants({ size }))}>
        <span className={cn(dotVariants({ size }))} />
      </span>
    </span>
  );
}

const radioCardVariants = cva(
  "group flex cursor-(--cursor-interactive) items-start border-2 border-border bg-card text-left text-card-foreground shadow-pop-sm transition-all hover:bg-accent active:translate-x-px active:translate-y-px active:shadow-none data-[checked=true]:bg-secondary data-[checked=true]:text-secondary-foreground data-[checked=true]:shadow-pop-md",
  {
    variants: {
      size: {
        sm: "gap-3 rounded-lg px-2.5 py-2 text-sm",
        default: "gap-3 rounded-lg px-3.5 py-3 text-base",
        lg: "gap-4 rounded-lg px-4.5 py-4 text-lg",
        xl: "gap-5 rounded-xl px-6 py-5 text-2xl shadow-pop-md",
      },
    },
    defaultVariants: { size: "default" },
  },
);

/**
 * Selectable "pick one" card — for diets, portion sizes, invite modes. A selected
 * card fills butter and grows to pop-md: the same visual grammar as the active nav
 * item, so "selected" always looks the same across the app.
 */
function RadioCard({
  className,
  size = "default",
  checked = false,
  title,
  description,
  name,
  value,
  onChange,
  children,
  ...props
}: Omit<React.ComponentProps<"label">, "size" | "title"> &
  VariantProps<typeof radioCardVariants> & {
    checked?: boolean;
    title: React.ReactNode;
    description?: React.ReactNode;
    name?: string;
    value?: string;
    onChange?: React.ChangeEventHandler<HTMLInputElement>;
  }) {
  return (
    <label data-slot="radio-card" data-checked={checked} className={cn(radioCardVariants({ size }), className)} {...props}>
      <Radio size={size} name={name} value={value} checked={checked} onChange={onChange} />
      <span className="min-w-0">
        <span className="font-semibold">{title}</span>
        {description ? <p className="m-0 mt-0.5 text-[0.875em] text-muted-foreground group-data-[checked=true]:text-secondary-foreground">{description}</p> : null}
        {children}
      </span>
    </label>
  );
}

export { RadioGroup, Radio, RadioCard, radioVariants, radioCardVariants };
