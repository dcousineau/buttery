import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { cn } from "#/lib/utils.ts";

/*
 * A field with "slots" on either side — the shadcn/Base UI take on Radix Themes' TextField.
 *
 *   <InputGroup>
 *     <InputGroupAddon><AtmosphereIcon /></InputGroupAddon>
 *     <InputGroupInput />
 *     <InputGroupAddon align="inline-end"><InputGroupButton>…</InputGroupButton></InputGroupAddon>
 *   </InputGroup>
 *
 * The group owns the chrome (2px border, focus ring + lifted shadow, invalid/warning
 * states) and the control inside strips its own, so the addons sit INSIDE the border
 * rather than beside it. An addon holds anything — an icon, `InputGroupText`, a `kbd`,
 * an `InputGroupButton` — and the group's `size` rides the shared control-height scale,
 * so it lines up with a bare `Input` at the same size.
 *
 * Problem states are read off the control with `has-*`, so a caller sets `aria-invalid`
 * or `data-warning="true"` on `InputGroupInput` exactly as they would on `Input`
 * (see components/ui/input.tsx for why there are two).
 */
const inputGroupVariants = cva(
  "group/input-group relative flex w-full min-w-0 items-center rounded-lg border-2 border-input bg-card transition-[box-shadow,border-color] outline-none has-disabled:cursor-not-allowed has-disabled:opacity-50 has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:shadow-pop has-[[data-slot=input-group-control]:focus-visible]:ring-3 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/50 has-[[data-slot=input-group-control][aria-invalid=true]]:border-destructive has-[[data-slot=input-group-control][aria-invalid=true]]:ring-3 has-[[data-slot=input-group-control][aria-invalid=true]]:ring-destructive/20 has-[[data-slot=input-group-control][data-warning=true]:not([aria-invalid=true])]:border-warning has-[[data-slot=input-group-control][data-warning=true]:not([aria-invalid=true])]:ring-3 has-[[data-slot=input-group-control][data-warning=true]:not([aria-invalid=true])]:ring-warning/25 dark:has-[[data-slot=input-group-control][aria-invalid=true]]:border-destructive/50 dark:has-[[data-slot=input-group-control][aria-invalid=true]]:ring-destructive/40 has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>textarea]:h-auto has-[>[data-align=inline-end]]:[&>input]:pe-2 has-[>[data-align=inline-start]]:[&>input]:ps-2",
  {
    variants: {
      size: {
        xs: "h-(--control-h-xs) text-xs [--input-group-px:var(--control-px-xs)]",
        sm: "h-(--control-h-sm) text-sm [--input-group-px:var(--control-px-sm)]",
        default: "h-(--control-h) text-base md:text-sm [--input-group-px:var(--control-px)]",
        lg: "h-(--control-h-lg) text-base md:text-sm [--input-group-px:var(--control-px-lg)]",
        xl: "h-(--control-h-xl) rounded-xl text-lg [--input-group-px:1.25rem]",
        "2xl": "h-(--control-h-2xl) rounded-xl text-2xl [--input-group-px:1.75rem]",
      },
    },
    defaultVariants: { size: "default" },
  },
);

type InputGroupSize = NonNullable<VariantProps<typeof inputGroupVariants>["size"]>;

/** The control inside a group is sized by the group, so the two can never disagree. */
const InputGroupSizeContext = React.createContext<InputGroupSize>("default");

function InputGroup({ className, size = "default", ...props }: React.ComponentProps<"div"> & VariantProps<typeof inputGroupVariants>) {
  return (
    <InputGroupSizeContext.Provider value={size ?? "default"}>
      <div data-slot="input-group" role="group" className={cn(inputGroupVariants({ size }), className)} {...props} />
    </InputGroupSizeContext.Provider>
  );
}

const inputGroupAddonVariants = cva(
  "flex h-auto items-center justify-center gap-2 font-medium text-muted-foreground select-none group-has-disabled/input-group:opacity-50 [&>kbd]:rounded-[calc(var(--radius)-5px)] [&>svg:not([class*='size-'])]:size-4",
  {
    variants: {
      align: {
        "inline-start": "order-first ps-(--input-group-px) has-[>button]:-ms-1",
        "inline-end": "order-last pe-(--input-group-px) has-[>button]:-me-1",
        "block-start": "order-first w-full justify-start px-(--input-group-px) pt-2",
        "block-end": "order-last w-full justify-start px-(--input-group-px) pb-2",
      },
    },
    defaultVariants: { align: "inline-start" },
  },
);

/**
 * A slot: decoration or an action sitting inside the field's border. Decorative content
 * (an icon, a unit) is not announced — the label names the field. No click-to-focus
 * listener: the field's label already does that, and a handler on a non-interactive
 * element is the wrong place for it.
 */
function InputGroupAddon({ className, align = "inline-start", ...props }: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return <div data-slot="input-group-addon" data-align={align} className={cn(inputGroupAddonVariants({ align }), className)} {...props} />;
}

/** A button that lives in a slot: flat, so it reads as part of the field and not a sticker on it. */
function InputGroupButton({ className, type = "button", variant = "ghost", size = "icon-xs", ...props }: React.ComponentProps<typeof Button>) {
  return <Button type={type} variant={variant} size={size} className={cn("shadow-none", className)} {...props} />;
}

function InputGroupText({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("flex items-center gap-2 text-muted-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4", className)} {...props} />;
}

// The control keeps its own text size and horizontal padding (from the group's size) but
// drops the chrome the group now draws, and fills the group's height. The shadow resets are
// `!important` because `cn` (tailwind-merge) does not know `shadow-pop` is a shadow, so it
// would keep the control's own focus shadow alongside the reset and draw a second one.
const controlChrome =
  "flex-1 rounded-none border-0 bg-transparent shadow-none! ring-0 focus-visible:shadow-none! focus-visible:ring-0 aria-invalid:ring-0 data-[warning=true]:not-aria-invalid:ring-0";

function InputGroupInput({ className, ...props }: Omit<React.ComponentProps<typeof Input>, "size">) {
  const size = React.useContext(InputGroupSizeContext);
  return <Input data-slot="input-group-control" size={size} className={cn(controlChrome, "h-full", className)} {...props} />;
}

function InputGroupTextarea({ className, ...props }: Omit<React.ComponentProps<typeof Textarea>, "size">) {
  const size = React.useContext(InputGroupSizeContext);
  // Textarea has no xs/sm step; the nearest one is the standard field.
  const textareaSize = size === "xs" || size === "sm" ? "default" : size;
  return <Textarea data-slot="input-group-control" size={textareaSize} className={cn(controlChrome, "resize-none", className)} {...props} />;
}

export { InputGroup, InputGroupAddon, InputGroupButton, InputGroupText, InputGroupInput, InputGroupTextarea };
