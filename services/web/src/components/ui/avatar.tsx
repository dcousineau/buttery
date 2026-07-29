"use client";

import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";

import { cn } from "#/lib/utils.ts";

/*
 * Neo-brutalist avatar: a circle with the signature 2px ink border and a flat
 * `--muted` fill behind the image / initials fallback (BRAND.md). No shadow —
 * an avatar is an identity mark, not a sticker control; sticker physics live on
 * whatever button wraps it (see UserMenu's trigger).
 */
function Avatar({ className, ...props }: AvatarPrimitive.Root.Props) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn("relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-border bg-muted select-none", className)}
      {...props}
    />
  );
}

function AvatarImage({ className, ...props }: AvatarPrimitive.Image.Props) {
  return <AvatarPrimitive.Image data-slot="avatar-image" className={cn("aspect-square size-full object-cover", className)} {...props} />;
}

function AvatarFallback({ className, ...props }: AvatarPrimitive.Fallback.Props) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn("flex size-full items-center justify-center rounded-full bg-muted text-[0.75em] leading-none font-semibold text-muted-foreground uppercase", className)}
      {...props}
    />
  );
}

export { Avatar, AvatarImage, AvatarFallback };
