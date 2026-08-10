import { cn } from "#/lib/utils.ts";

/**
 * A recipe's photo, read from the folder the user dropped (plan §11, D26).
 *
 * The bytes never leave the tab: this renders an object URL over the local `File`, while
 * the commit path sends `imageSourceUrl` — the original remote URL — and uploads nothing.
 * The URL comes from the session's image cache, which owns revoking it, so this component
 * holds no lifecycle of its own and can render 341 times without leaking.
 *
 * A missing photo is normal (an export whose assets never synced), so the fallback is a
 * plain tile rather than a broken-image icon or an error.
 */
export function LocalImage({ url, alt, className }: { url: string | null; alt: string; className?: string }) {
  if (!url) {
    return <div aria-hidden="true" className={cn("rounded-lg border-2 border-border bg-muted", className)} />;
  }
  // `alt` is the recipe's name: the photo carries no information the name does not, so a
  // screen reader gets the name once from the heading and nothing extra here.
  return <img src={url} alt={alt} className={cn("rounded-lg border-2 border-border bg-muted object-cover", className)} />;
}
