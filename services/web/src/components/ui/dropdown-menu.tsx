"use client";

import * as React from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { cn } from "#/lib/utils.ts";
import { ChevronRightIcon, CheckIcon } from "lucide-react";

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

/*
 * BOTTOM SHEET ON A THUMB, ANCHORED POPUP ON A CURSOR.
 *
 * A menu anchored to its trigger is right for a mouse and wrong for a hand: on a
 * phone it opens under the finger that is covering it, near whichever screen edge
 * the trigger happens to sit at, and its rows are sized for a cursor. Every phone
 * OS answers this the same way — the menu comes up from the bottom, full width,
 * where the thumb already is.
 *
 * This is done in CSS, on the SAME element tree, rather than by branching to a
 * real `Sheet` on `useIsMobile()`. The items have to stay inside
 * `Positioner > Popup` for Base UI's composite list to work at all — arrow keys,
 * typeahead, `closeOnClick`, focus restoration — and a JS branch would mean two
 * DOM shapes, two sets of those behaviors, and a re-mount on resize.
 *
 * The `!` markers are load-bearing and not laziness: Base UI's positioner writes
 * `position`, `top`, `left` and `transform` as INLINE styles every frame it
 * measures, so a plain class cannot outrank them. `transform-none!` is what stops
 * the positioner's translate from moving the sheet off the bottom edge.
 */
const TOUCH_SHEET_POSITIONER = "touch:fixed! touch:inset-x-0! touch:top-auto! touch:bottom-0! touch:w-auto! touch:transform-none!";

const TOUCH_SHEET_POPUP = [
  // Full width, hinged on the bottom edge: square off the corners and the border
  // that are now flush with the screen, and drop the sticker shadow, which has
  // nothing left to cast onto.
  "touch:w-full! touch:max-h-[70svh]! touch:rounded-t-2xl touch:rounded-b-none touch:border-x-0 touch:border-b-0 touch:shadow-none",
  // Home-indicator clearance — never less than the 8px the popup already had.
  "touch:p-2 touch:pb-[max(0.5rem,env(safe-area-inset-bottom))]",
  // Rise from the edge it is attached to instead of zooming out of the trigger.
  "touch:data-open:slide-in-from-bottom-full! touch:data-open:zoom-in-100! touch:data-closed:slide-out-to-bottom-full! touch:data-closed:zoom-out-100!",
  // The grabber. Decorative, and a pseudo-element rather than a part, because it
  // is the one pixel of chrome that tells a thumb this came from the bottom.
  "touch:before:mx-auto touch:before:mb-2 touch:before:block touch:before:h-1 touch:before:w-10 touch:before:rounded-full touch:before:bg-border",
].join(" ");

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  sheetOnTouch = true,
  className,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset"> & {
    /**
     * Present as a bottom sheet on a coarse pointer. False for a SUBMENU, which
     * has a parent menu to stay attached to — two stacked sheets would hide the
     * choice that opened the second one.
     */
    sheetOnTouch?: boolean;
  }) {
  return (
    <MenuPrimitive.Portal>
      {/* Dims the page behind the sheet so the menu reads as a layer rather than
          as part of the screen. Inert on a fine pointer — `pointer-events-none`
          rather than absent, so a desktop click still lands on whatever is under
          it, exactly as it did before there was a backdrop. */}
      {sheetOnTouch ? (
        <MenuPrimitive.Backdrop
          data-slot="dropdown-menu-backdrop"
          className="pointer-events-none fixed inset-0 z-(--z-popover) duration-150 touch:pointer-events-auto touch:bg-foreground/40 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        />
      ) : null}
      <MenuPrimitive.Positioner
        className={cn("isolate z-(--z-popover) outline-none", sheetOnTouch && TOUCH_SHEET_POSITIONER)}
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "z-(--z-popover) max-h-(--available-height) w-(--anchor-width) min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground border-2 border-border shadow-pop-md duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95",
            sheetOnTouch && TOUCH_SHEET_POPUP,
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn("px-1.5 py-1 text-xs font-medium text-muted-foreground touch:px-3 touch:py-2 touch:text-sm data-inset:pl-7", className)}
      {...props}
    />
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        // 56px on a thumb: a full-width sheet row can afford the step above the
        // 44px floor, and the extra height is what keeps a mis-aimed tap from
        // landing on "Sign out" when it meant "Theme".
        "group/dropdown-menu-item relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm touch:h-14 touch:gap-3.5 touch:rounded-lg touch:px-3 touch:text-base touch:[&_svg:not([class*='size-'])]:size-5  outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "touch:h-14 touch:gap-3.5 touch:rounded-lg touch:px-3 touch:text-base touch:[&_svg:not([class*='size-'])]:size-5 flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-popup-open:bg-accent data-popup-open:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function DropdownMenuSubContent({ align = "start", alignOffset = -3, side = "right", sideOffset = 0, className, ...props }: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      sheetOnTouch={false}
      data-slot="dropdown-menu-sub-content"
      className={cn(
        "w-auto min-w-[96px] rounded-lg bg-popover p-1 text-popover-foreground border-2 border-border shadow-pop-md duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
        className,
      )}
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "touch:h-14 touch:gap-3.5 touch:rounded-lg touch:px-3 touch:text-base touch:[&_svg:not([class*='size-'])]:size-5 touch:pr-10! relative flex cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute right-2 flex items-center justify-center" data-slot="dropdown-menu-checkbox-item-indicator">
        <MenuPrimitive.CheckboxItemIndicator>
          <CheckIcon />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: MenuPrimitive.RadioItem.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(
        "touch:h-14 touch:gap-3.5 touch:rounded-lg touch:px-3 touch:text-base touch:[&_svg:not([class*='size-'])]:size-5 touch:pr-10! relative flex cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute right-2 flex items-center justify-center" data-slot="dropdown-menu-radio-item-indicator">
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return <MenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn("-mx-1 my-1 h-px bg-border touch:-mx-2 touch:my-1.5", className)} {...props} />;
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn("ml-auto text-xs tracking-widest text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground", className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
