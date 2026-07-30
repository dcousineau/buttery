import { Avatar, AvatarFallback, AvatarImage } from "#/components/ui/avatar";
import { cn } from "#/lib/utils.ts";

/**
 * Reusable identity avatar — the profile picture pulled from atproto at sign-in
 * (`user.image`), with a graceful initials fallback when there's no photo (or
 * it hasn't loaded / 404s). Use anywhere a person is shown: the account menu,
 * household member rows, recipe authors, etc.
 *
 * Initials come from the display name if given, otherwise the handle's local
 * part (`alice.bsky.social` → `AL`). Fallback uses the neutral `--muted` fill
 * from the primitive — no per-user tint, to stay on semantic tokens.
 */
const SIZES = {
  sm: "size-7 text-[0.7rem]",
  md: "size-8 text-xs",
  lg: "size-10 text-sm",
  xl: "size-14 text-lg",
} as const;

export type UserAvatarSize = keyof typeof SIZES;

function initialsFrom(displayName?: string | null, handle?: string | null): string {
  const source = displayName?.trim() || handle?.replace(/^@/, "").split(".")[0] || "";
  if (!source) return "?";
  const words = source.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export default function UserAvatar({
  handle,
  displayName,
  image,
  size = "md",
  className,
}: {
  handle?: string | null;
  displayName?: string | null;
  image?: string | null;
  size?: UserAvatarSize;
  className?: string;
}) {
  const label = displayName?.trim() || (handle ? `@${handle}` : "User");
  return (
    <Avatar className={cn(SIZES[size], className)}>
      {image ? <AvatarImage src={image} alt={label} /> : null}
      <AvatarFallback aria-label={label}>{initialsFrom(displayName, handle)}</AvatarFallback>
    </Avatar>
  );
}
