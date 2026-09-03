import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "#/lib/utils.ts";

/*
 * Pop-art sticker physics (BRAND.md): hard offset shadow, lifts on hover,
 * presses down on click. Applied to solid variants only — ghost/link stay flat.
 */
const popShadow =
  "shadow-pop hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-pop-lg active:translate-x-0.5 active:translate-y-0.5 active:shadow-pop-sm disabled:shadow-pop";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border-2 border-transparent bg-clip-padding text-sm font-semibold whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: `border-border bg-primary text-primary-foreground ${popShadow}`,
        outline: `border-border bg-card text-foreground hover:bg-accent aria-expanded:bg-accent ${popShadow}`,
        secondary: `border-border bg-secondary text-secondary-foreground aria-expanded:bg-secondary aria-expanded:text-secondary-foreground ${popShadow}`,
        ghost: "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive: `border-border bg-destructive text-primary-foreground focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 ${popShadow}`,
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-(--control-h) gap-1.5 px-(--control-px) has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-(--control-h-xs) gap-1 rounded-[min(var(--radius-md),10px)] px-(--control-px-xs) text-xs in-data-[slot=button-group]:rounded-lg touch:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-(--control-h-sm) gap-1 rounded-[min(var(--radius-md),12px)] px-(--control-px-sm) text-[0.8rem] in-data-[slot=button-group]:rounded-lg touch:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-(--control-h-lg) gap-1.5 px-(--control-px-lg) has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        // Cook mode: full-screen, arm's-length, flour-on-your-hands (BRAND.md).
        // Not re-pointed by the touch block — 48px and 64px are already past the floor.
        xl: "h-(--control-h-xl) gap-2 rounded-xl px-5 text-lg has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4 [&_svg:not([class*='size-'])]:size-5",
        "2xl": "h-(--control-h-2xl) gap-3 rounded-xl px-7 text-2xl has-data-[icon=inline-end]:pr-5 has-data-[icon=inline-start]:pl-5 [&_svg:not([class*='size-'])]:size-7",
        icon: "size-(--control-h)",
        "icon-xs":
          "size-(--control-h-xs) rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg touch:rounded-lg [&_svg:not([class*='size-'])]:size-3 touch:[&_svg:not([class*='size-'])]:size-4",
        "icon-sm": "size-(--control-h-sm) rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg touch:rounded-lg touch:[&_svg:not([class*='size-'])]:size-5",
        "icon-lg": "size-(--control-h-lg)",
        "icon-xl": "size-(--control-h-xl) rounded-xl [&_svg:not([class*='size-'])]:size-5",
        "icon-2xl": "size-(--control-h-2xl) rounded-xl [&_svg:not([class*='size-'])]:size-7",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({ className, variant = "default", size = "default", ...props }: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
