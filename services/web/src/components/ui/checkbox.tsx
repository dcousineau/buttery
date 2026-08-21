import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { CheckIcon, MinusIcon } from "lucide-react";

import { cn } from "#/lib/utils.ts";

/*
 * Neo-brutalist checkbox (BRAND.md): 2px ink border, butter fill when checked,
 * hard offset shadow that flattens on press.
 *
 * Two deliberate details:
 * 1. The box and glyph are REAL elements over a visually-hidden native input, not
 *    pseudo-elements — pseudo-element-only visuals disappear in DOM-rasterised
 *    capture (design-system thumbnails, print/PDF, PPTX export).
 * 2. Radii are TIGHTER than the global radius scale at small sizes (3px at 16px)
 *    because a rounded 16px square reads as a radio button. At small sizes the
 *    square corner IS what separates "check" from "choose".
 */

const checkboxVariants = cva(
  "flex shrink-0 items-center justify-center border-2 border-border bg-card shadow-pop-sm transition-all peer-checked:bg-secondary peer-indeterminate:bg-secondary peer-active:translate-x-px peer-active:translate-y-px peer-active:shadow-none peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-checked:[&>svg]:scale-100 peer-checked:[&>svg]:opacity-100 peer-indeterminate:[&>svg]:scale-100 peer-indeterminate:[&>svg]:opacity-100",
  {
    variants: {
      size: {
        sm: "size-4 rounded-[3px]",
        default: "size-5 rounded-[4px]",
        lg: "size-7 rounded-[6px]",
        // Cook mode: 40px box, ≥44px effective hit target inside a CheckboxRow.
        xl: "size-10 rounded-[8px] shadow-pop",
      },
    },
    defaultVariants: { size: "default" },
  },
);

const glyphVariants = cva("scale-60 text-secondary-foreground opacity-0 transition-all", {
  variants: {
    size: { sm: "size-3", default: "size-4", lg: "size-5", xl: "size-7" },
  },
  defaultVariants: { size: "default" },
});

function Checkbox({
  className,
  size = "default",
  indeterminate = false,
  ...props
}: Omit<React.ComponentProps<"input">, "size" | "type"> &
  VariantProps<typeof checkboxVariants> & {
    /** Renders the dash glyph — a partially-checked recipe or store aisle. */
    indeterminate?: boolean;
  }) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <span data-slot="checkbox" className={cn("relative inline-flex shrink-0 align-middle", props.disabled && "opacity-50", className)}>
      <input
        ref={ref}
        type="checkbox"
        className="peer absolute inset-0 size-full cursor-(--cursor-interactive) opacity-0 disabled:cursor-not-allowed"
        aria-checked={indeterminate ? "mixed" : undefined}
        {...props}
      />
      <span className={cn(checkboxVariants({ size }))}>
        {indeterminate ? (
          <MinusIcon className={cn(glyphVariants({ size }))} strokeWidth={4} aria-hidden />
        ) : (
          <CheckIcon className={cn(glyphVariants({ size }))} strokeWidth={4} aria-hidden />
        )}
      </span>
    </span>
  );
}

const checkboxRowVariants = cva(
  "flex w-full cursor-(--cursor-interactive) items-center border-2 border-border bg-card text-left text-card-foreground shadow-pop-sm transition-all hover:bg-accent active:translate-x-px active:translate-y-px active:shadow-none",
  {
    variants: {
      size: {
        sm: "gap-3 rounded-lg px-2.5 py-2 text-sm",
        default: "gap-3 rounded-lg px-3 py-2.5 text-base",
        lg: "gap-4 rounded-lg px-4 py-3.5 text-lg",
        xl: "gap-5 rounded-xl px-5 py-4.5 text-2xl shadow-pop-md",
      },
      /**
       * What a tick MEANS on this row, which is the whole of what the checked
       * paint should say.
       *
       * `task` is the checklist dialect from BRAND.md — an ingredient, a
       * shopping line, a meal-plan claim. Checked is *done*, so the row strikes
       * through and drops its shadow, and remaining work stands proud of it.
       *
       * `selection` is membership — "this recipe is on that shelf", "this
       * option is chosen". Checked is a standing fact, not finished work, and
       * striking it through reads as "removed" to everyone who sees it. It
       * takes the butter selection fill instead, the same `accent` the app uses
       * everywhere else for "this one is the chosen one".
       */
      tone: {
        task: "data-[checked=true]:bg-muted/60 data-[checked=true]:shadow-none data-[checked=true]:[&_[data-slot=row-label]]:text-muted-foreground data-[checked=true]:[&_[data-slot=row-label]]:line-through data-[checked=true]:[&_[data-slot=row-label]]:decoration-2",
        selection: "data-[checked=true]:bg-accent",
      },
    },
    defaultVariants: { size: "default", tone: "task" },
  },
);

/**
 * The checklist pattern (BRAND.md): the WHOLE ROW is the hit target, and a checked
 * row strikes through and drops its shadow so remaining work stands proud of done
 * work. Use for ingredients, shopping-list lines and meal-plan claims.
 */
function CheckboxRow({
  className,
  size = "default",
  tone = "task",
  checked = false,
  disabled = false,
  onCheckedChange,
  meta,
  children,
  ...props
}: Omit<React.ComponentProps<"label">, "size"> &
  VariantProps<typeof checkboxRowVariants> & {
    checked?: boolean;
    /**
     * A row whose state is a *fact*, not a choice — a recipe already filed on
     * the shelf you are adding to, a line someone else claimed. It keeps its
     * tick and its label in the accessibility tree (a disabled checkbox still
     * announces "checked"), and only the sticker physics go quiet.
     */
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    /** Right-aligned muted text — quantity, aisle, assignee. */
    meta?: React.ReactNode;
  }) {
  return (
    <label
      data-slot="checkbox-row"
      data-checked={checked}
      data-disabled={disabled || undefined}
      className={cn(
        checkboxRowVariants({ size, tone }),
        disabled && "cursor-default opacity-70 shadow-none hover:bg-card active:translate-x-0 active:translate-y-0 active:shadow-none",
        className,
      )}
      {...props}
    >
      <Checkbox size={size} checked={checked} disabled={disabled} onChange={(e) => onCheckedChange?.(e.target.checked)} />
      <span data-slot="row-label" className="min-w-0 flex-1">
        {children}
      </span>
      {meta ? <span className="shrink-0 text-muted-foreground">{meta}</span> : null}
    </label>
  );
}

export { Checkbox, CheckboxRow, checkboxVariants, checkboxRowVariants };
