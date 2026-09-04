"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "#/lib/utils.ts";

/**
 * An infotip: a tooltip-shaped popup that a touch user can actually open.
 *
 * Looks like {@link Tooltip} — same dark chip, same arrow, same `text-xs` —
 * but it is a Popover underneath, and that is the whole point. Base UI's
 * tooltip is hover-and-keyboard only *by construction*: its hover hook runs
 * `mouseOnly: true` and its focus hook ignores focus that doesn't match
 * `:focus-visible`, so on iOS there is no event sequence a user can produce
 * that opens one. Their own docs say so and prescribe exactly this swap:
 *
 *   > Popups that open when hovering an info icon should use Popover with the
 *   > `openOnHover` prop on the trigger instead of a tooltip. This way, touch
 *   > users and screen reader users can access the content.
 *
 * Their test for which primitive you want: if the trigger's purpose is to open
 * the popup, it's a popover; if the trigger's purpose is unrelated, it's a
 * tooltip. A chip whose only interactive job is to explain where it came from
 * is a popover by that rule.
 *
 * What the swap buys, beyond the tap: real disclosure semantics
 * (`aria-expanded`, `aria-controls` on the trigger, `role="dialog"` on the
 * popup) instead of a hover-only `aria-describedby`, so a screen reader user
 * can reach the content deliberately rather than hoping it was announced.
 *
 * Focus does NOT move on hover — `PopoverPopup` disables its focus manager
 * when the open reason is `triggerHover`, so a mouse user gets tooltip
 * behaviour exactly. On a tap, focus lands in the popup and returns to the
 * trigger on close, which is what makes it reachable at all.
 *
 * Use this whenever the content is supplementary provenance/clarification
 * attached to something a thumb can reach. Keep {@link Tooltip} for genuinely
 * hover-only affordances — keyboard shortcut hints, collapsed sidebar labels —
 * where there is nothing for a touch user to miss.
 */
function Infotip({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="infotip" {...props} />;
}

/**
 * `openOnHover` defaults ON — that is what makes this read as a tooltip on a
 * desktop pointer. Click/tap opens it on every device regardless, which is the
 * Popover behaviour we came here for.
 *
 * `delay` matches Base UI's tooltip default (600ms) rather than the popover's
 * (300ms): this is a tooltip to the eye, so it should feel like one to the
 * hand.
 *
 * Renders a `<button>` unless given `render`. When rendering a non-interactive
 * element (a `Badge` span, say), give it `cursor-pointer` — React delegates
 * listeners to the root container, and Safari only synthesizes a `click` on a
 * non-interactive element that looks clickable. Without it an iOS tap produces
 * `pointerdown` and nothing else, which is the exact bug this component exists
 * to fix.
 */
function InfotipTrigger({ openOnHover = true, delay = 600, ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="infotip-trigger" openOnHover={openOnHover} delay={delay} {...props} />;
}

/**
 * Deliberately a copy of `TooltipContent`'s styling rather than a shared
 * constant: these are two different primitives that happen to look alike
 * today, and welding them together would mean a change to one silently
 * restyles the other. The duplication is the cheaper of the two mistakes.
 */
function InfotipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: PopoverPrimitive.Popup.Props & Pick<PopoverPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner align={align} alignOffset={alignOffset} side={side} sideOffset={sideOffset} className="isolate z-(--z-popover) outline-none">
        <PopoverPrimitive.Popup
          data-slot="infotip-content"
          className={cn(
            "z-(--z-popover) inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        >
          {children}
          <PopoverPrimitive.Arrow className="z-(--z-popover) size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" />
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Infotip, InfotipTrigger, InfotipContent };
