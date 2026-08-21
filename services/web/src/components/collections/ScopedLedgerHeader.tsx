import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { cn } from "#/lib/utils";
import { type LedgerScope, scopeLabel } from "./scope";

/**
 * The strip above the ledger naming what it is currently showing, how much of it
 * there is, and how to get back to the whole box (§7).
 *
 * It renders only for a scope that is *not* the landing view — the default is
 * the whole box A–Z, and a banner announcing "My recipes · 33" above a list of
 * 33 recipes is furniture, not information. The tree's own highlight is what
 * says which smart row you are on.
 *
 * Clearing is a **link**, not a button, because scope is URL state: it gets the
 * back button, "open in new tab", and a real href, and it costs nothing.
 */
export function ScopedLedgerHeader({ scope, count, className }: { scope: LedgerScope; count: number; className?: string }) {
  const description = scope.kind === "collection" ? scope.collection.description : null;
  const missing = scope.kind === "missing-collection";

  return (
    <div className={cn("flex flex-none items-center gap-2 border-b-2 border-border/45 bg-background px-2.5 py-1.5", className)}>
      <div className="min-w-0 flex-1">
        <p className="m-0 truncate text-[0.8125rem] font-bold text-foreground">{scopeLabel(scope)}</p>
        {description ? (
          <p className="m-0 truncate text-[0.6875rem] font-medium text-muted-foreground">{description}</p>
        ) : (
          !missing && (
            <p className="m-0 text-[0.6875rem] font-semibold text-muted-foreground">
              {count} {count === 1 ? "recipe" : "recipes"}
            </p>
          )
        )}
      </div>
      <Link
        to="/household/recipes"
        search={{}}
        aria-label="Show the whole box"
        className="grid size-6 shrink-0 place-content-center rounded-md text-muted-foreground no-underline transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
      >
        <X className="size-3.5" aria-hidden="true" />
      </Link>
    </div>
  );
}
