import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "#/lib/utils.ts";

/*
 * Neo-brutalist accordion (BRAND.md). Each item is a card in its own right — 2px
 * ink border, hard shadow that GROWS from pop-sm to pop-md when open, so an open
 * panel reads as a lifted sticker.
 *
 * Defaults to type="multiple" on purpose: a cook wants two recipe stages open at
 * once. Use "single" for FAQ/settings.
 *
 * The chevron ROTATES 90° — it never flips. Consistent with dropdown submenus.
 */

const accordionVariants = cva("flex flex-col gap-2", {
  variants: {
    size: { sm: "", default: "", xl: "" },
  },
  defaultVariants: { size: "default" },
});

const triggerVariants = cva(
  "flex w-full cursor-(--cursor-interactive) items-center gap-3 border-0 bg-transparent text-left font-semibold text-inherit outline-none hover:bg-accent hover:text-accent-foreground focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-ring",
  {
    variants: {
      size: {
        sm: "min-h-8 px-3 py-1.5 text-sm",
        default: "min-h-9 px-3.5 py-2 text-base",
        xl: "min-h-12 px-5 py-3.5 text-xl",
      },
    },
    defaultVariants: { size: "default" },
  },
);

const panelVariants = cva("border-t-2 border-border", {
  variants: {
    size: {
      sm: "px-3 py-2.5 text-sm",
      default: "px-3.5 py-3 text-sm",
      xl: "px-5 py-4.5 text-lg leading-relaxed",
    },
  },
  defaultVariants: { size: "default" },
});

type AccordionSize = "sm" | "default" | "xl";

const AccordionContext = React.createContext<{ open: string[]; toggle: (value: string) => void; size: AccordionSize }>({
  open: [],
  toggle: () => {},
  size: "default",
});
const ItemContext = React.createContext<{ value: string; isOpen: boolean }>({ value: "", isOpen: false });

function Accordion({
  className,
  type = "multiple",
  defaultOpen = [],
  size = "default",
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "size"> &
  VariantProps<typeof accordionVariants> & {
    type?: "single" | "multiple";
    /** Item `value`s open on first render. */
    defaultOpen?: string[];
  }) {
  const [open, setOpen] = React.useState<string[]>(defaultOpen);
  const toggle = React.useCallback(
    (value: string) => setOpen((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : type === "single" ? [value] : [...prev, value])),
    [type],
  );
  const ctx = React.useMemo(() => ({ open, toggle, size: (size ?? "default") as AccordionSize }), [open, toggle, size]);
  return (
    <div data-slot="accordion" className={cn(accordionVariants({ size }), className)} {...props}>
      <AccordionContext.Provider value={ctx}>{children}</AccordionContext.Provider>
    </div>
  );
}

function AccordionItem({ className, value, children, ...props }: React.ComponentProps<"div"> & { value: string }) {
  const { open, size } = React.useContext(AccordionContext);
  const isOpen = open.includes(value);
  return (
    <ItemContext.Provider value={{ value, isOpen }}>
      <div
        data-slot="accordion-item"
        data-open={isOpen || undefined}
        className={cn(
          "overflow-hidden border-2 border-border bg-card text-card-foreground shadow-pop-sm data-open:shadow-pop-md",
          size === "xl" ? "rounded-xl shadow-pop-md" : "rounded-lg",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </ItemContext.Provider>
  );
}

function AccordionTrigger({ className, children, ...props }: React.ComponentProps<"button">) {
  const { toggle, size } = React.useContext(AccordionContext);
  const { value, isOpen } = React.useContext(ItemContext);
  return (
    <button type="button" data-slot="accordion-trigger" aria-expanded={isOpen} onClick={() => toggle(value)} className={cn(triggerVariants({ size }), className)} {...props}>
      {children}
      <ChevronRightIcon className={cn("ml-auto shrink-0 transition-transform", isOpen && "rotate-90")} strokeWidth={2.5} aria-hidden />
    </button>
  );
}

function AccordionContent({ className, children, ...props }: React.ComponentProps<"div">) {
  const { size } = React.useContext(AccordionContext);
  const { isOpen } = React.useContext(ItemContext);
  if (!isOpen) return null;
  return (
    <div data-slot="accordion-content" className={cn(panelVariants({ size }), className)} {...props}>
      {children}
    </div>
  );
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
