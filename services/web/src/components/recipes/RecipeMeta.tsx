import { Children, Fragment, type ReactNode } from "react";
import { cn } from "#/lib/utils";

/**
 * The byline row under a recipe title: its children separated by "·".
 *
 * Every segment is optional — a recipe may have no credited source, no resolved
 * publisher, no publish date — so the separators are interleaved here rather
 * than hung off each segment, where a missing segment would leave its dot
 * behind.
 */
export function MetaRow({ children, className }: { children: ReactNode; className?: string }) {
  const items = Children.toArray(children);
  return (
    <div className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-1", className)}>
      {items.map((child, i) => (
        // Positional keys: the row is rendered whole on every pass, never reordered.
        <Fragment key={i}>
          {i > 0 && <span aria-hidden>·</span>}
          {child}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The atproto account a recipe was published from, linked to its profile.
 *
 * The link is the point: a handle is an address, and every network surface that
 * names one should let a reader go read the account. `url` is null only when the
 * handle never resolved (a DID-only repo has no bsky.app profile route), which
 * is the one case this renders as text.
 */
export function PublisherLink({ handle, url, className }: { handle: string; url: string | null; className?: string }) {
  const classes = cn("font-semibold text-foreground", className);
  if (!url) return <span className={classes}>{handle}</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className={cn(classes, "hover:underline")}>
      {handle}
    </a>
  );
}
