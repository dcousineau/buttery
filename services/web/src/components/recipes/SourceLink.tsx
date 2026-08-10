import { SourceIcon } from "./SourceIcon";
import type { RecipeSource } from "#/server/recipe-provenance";
import { cn } from "#/lib/utils";

/**
 * A recipe's provenance, rendered once for every surface that shows it: glyph +
 * label, and a link whenever `deriveSource` resolved one — the site a recipe was
 * scraped from, or the publisher's atproto profile.
 *
 * The label being *text* when there is a URL sitting right next to it was the
 * bug this replaces: "smittenkitchen.com" under an external-link glyph reads as
 * a link, so not being one is a small lie the design tells on every card.
 *
 * Renders a `<span>` when `source.url` is null, so callers can hand it any
 * source without branching. **It does not render an anchor safely inside
 * another anchor or button** — nested interactive content is invalid HTML and a
 * keyboard trap. Rows that are themselves a link (the ledger slat, the global
 * picker's result buttons, the pantry's box card) keep {@link SourceIcon} plus
 * plain text on purpose; the destination is one click further in.
 */
export function SourceLink({
  source,
  className,
  iconClassName = "size-3.5",
}: {
  source: RecipeSource;
  className?: string;
  /** Sized by the caller — this label rides meta rows from 11px to 14px. */
  iconClassName?: string;
}) {
  const body = (
    <>
      <SourceIcon kind={source.kind} className={cn("shrink-0", iconClassName)} />
      {source.label}
    </>
  );

  if (!source.url) return <span className={cn("inline-flex items-center gap-1 whitespace-nowrap", className)}>{body}</span>;

  return (
    <a
      href={source.url}
      target="_blank"
      // `nofollow` because a scraped recipe's source URL is user-supplied and we
      // are not vouching for it; `noopener noreferrer` because `_blank` without
      // them hands the opened page a handle on ours.
      rel="noreferrer noopener nofollow"
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap text-inherit underline decoration-from-font underline-offset-4 transition-colors hover:text-foreground",
        className,
      )}
    >
      {body}
      {/* The glyph says "external" to anyone who can see it. This says it to
          everyone else, and is the only reason the icon can stay aria-hidden. */}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
