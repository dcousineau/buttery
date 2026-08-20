import type { ComponentType, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { FolderLock, Settings2 } from "lucide-react";
import type { CollectionSummary } from "#/lib/api";
import { selectableRowVariants } from "#/components/ui/selectable-row";
import { cn } from "#/lib/utils";
import type { ScopeSearch } from "./scope";

/**
 * One row of the collections tree — a smart row or a real collection.
 *
 * **The row is a link, not a button.** Scope lives in the URL (§7), so picking a
 * shelf is navigation: it gets middle-click, "open in new tab", a real
 * `aria-current`, and a back button that does what it looks like it does. The
 * gear sits *outside* the link, because a button inside an anchor is invalid
 * HTML that browsers silently reparent.
 *
 * The selected paint is `selectableRowVariants` — the app's one "this row is the
 * current row" treatment (butter fill plus a leading butter bar), the same one
 * the ledger's slats use two hundred pixels to the right. A nav tree and a
 * ledger sitting side by side that disagreed about what "selected" looks like
 * would read as two apps.
 */

export function CollectionTreeRow({
  icon: Icon,
  label,
  count,
  active,
  search,
  onNavigate,
  trailing,
  leading,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  /** Shown after the name; `null` renders no count at all. */
  count: number | null;
  active: boolean;
  /** The scope this row navigates to. Replaces the layout route's search wholesale. */
  search: ScopeSearch;
  /** Milestone 4's sheet closes itself here; the desktop column passes nothing. */
  onNavigate?: () => void;
  /** Row-level affordances that must not live inside the link (the gear). */
  trailing?: ReactNode;
  /** TODO(m3): the drag handle mounts here, ahead of the link. */
  leading?: ReactNode;
}) {
  return (
    // TODO(m3): this <li> becomes the drop target for a ledger card
    // (`application/x-buttery-recipe`) and the drag source for list reorder.
    // Both attach here, so the link and the gear keep their own hit targets.
    <li className={cn("group/row flex items-center gap-0.5 pr-1", selectableRowVariants({ selected: active }))}>
      {leading}
      <Link
        to="/household/recipes"
        search={search}
        onClick={onNavigate}
        aria-current={active ? "true" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2.5 text-[0.8125rem] font-semibold text-foreground no-underline focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-ring"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count != null && (
          <span className="shrink-0 text-[0.6875rem] font-bold tabular-nums text-muted-foreground">
            {count}
            <span className="sr-only"> {count === 1 ? "recipe" : "recipes"}</span>
          </span>
        )}
      </Link>
      {trailing}
    </li>
  );
}

/**
 * A real collection: name, membership count, and the gear that opens the edit
 * dialog.
 *
 * The gear is hover-revealed but **never hover-only** — it is a real button in
 * the tab order at all times, and `group-focus-within` brings it into view the
 * moment a keyboard reaches the row. Opacity, not `hidden`: a control that
 * leaves the accessibility tree when it is not hovered is a control a screen
 * reader user does not have.
 */
export function CollectionRow({
  collection,
  active,
  onNavigate,
  onEdit,
}: {
  collection: CollectionSummary;
  active: boolean;
  onNavigate?: () => void;
  onEdit: (collection: CollectionSummary) => void;
}) {
  return (
    <CollectionTreeRow
      // `folder-lock` is the established glyph for collections (BRAND.md), and
      // the padlock is the honest part: these shelves are household-only.
      icon={FolderLock}
      label={collection.name}
      count={collection.recipeIds.length}
      active={active}
      search={{ c: collection.id }}
      onNavigate={onNavigate}
      trailing={
        <button
          type="button"
          onClick={() => onEdit(collection)}
          aria-label={`Edit ${collection.name}`}
          className="grid size-6 shrink-0 cursor-(--cursor-interactive) place-content-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring group-hover/row:opacity-100 group-focus-within/row:opacity-100"
        >
          <Settings2 className="size-3.5" aria-hidden="true" />
        </button>
      }
    />
  );
}
