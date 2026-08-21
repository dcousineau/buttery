import { EyeOff } from "lucide-react";
import type { CollectionSummary } from "#/lib/api";
import { Button } from "#/components/ui/button";
import { CheckboxRow } from "#/components/ui/checkbox";
import { cn } from "#/lib/utils";

/**
 * One collection, as a tickable row — the shared body of the desktop picker dialog
 * and the mobile "File this recipe" sheet.
 *
 * It exists because both surfaces answer the same question ("which collections does
 * this recipe belong in?") and both have to refuse the same case: a published
 * collection may not hold a private recipe (§2.4). That refusal is the row
 * "Publish recipe & add" hangs off, and two copies of it would mean two places
 * to keep that in step. One row, one place.
 *
 * The tick is `tone="selection"`, not the checklist's strike-through: membership
 * is a standing fact, not finished work, and a collection struck through reads as
 * "removed" (see `ui/checkbox.tsx`).
 *
 * ## The blocked row and its escape hatch (§2.4)
 *
 * A private recipe cannot go on a published collection, because the record would
 * point at something nobody else can read. The rule is real and the server
 * enforces it — but the answer is almost always "then publish the recipe", so
 * the row offers to do both in one call rather than sending someone to the
 * recipe, back to the collection, and into the same dialog again.
 *
 * **Consent is per-recipe and never inferred**: the combo is a button someone
 * presses, and `addRecipesToCollection` only publishes the ids it is explicitly
 * given (`publishRecipeIds`). Filing has never been allowed to make a recipe
 * public as a side effect, and it still is not.
 */
export function CollectionCheckRow({
  collection,
  filed,
  /** A private recipe against a published collection — the §2.4 refusal. */
  blocked,
  size,
  disabledHint,
  onToggle,
  onPublishAndAdd,
  publishing = false,
}: {
  collection: CollectionSummary;
  filed: boolean;
  blocked: boolean;
  /** `sm` in the desktop dialog; `default` on mobile, where the row is ≥44px. */
  size: "sm" | "default";
  /** Non-null disables the tick and explains why (offline). */
  disabledHint?: string;
  onToggle: (checked: boolean) => void;
  /** Publish this recipe, then file it here — one call (§5). */
  onPublishAndAdd?: () => void;
  publishing?: boolean;
}) {
  if (blocked) {
    return (
      <div
        className={cn(
          "flex w-full items-center gap-3 rounded-lg border-2 border-dashed border-border/60 bg-muted/40 text-sm text-muted-foreground",
          size === "sm" ? "px-2.5 py-2" : "min-h-11 px-3 py-2.5",
        )}
      >
        <EyeOff className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{collection.name}</span>
          <span className="block text-xs">Published collection — a private recipe can’t go on it.</span>
        </span>
        {onPublishAndAdd && (
          <Button
            type="button"
            variant="outline"
            size={size === "sm" ? "xs" : undefined}
            className={cn("shrink-0", size === "default" && "h-11")}
            disabled={disabledHint != null || publishing}
            title={disabledHint}
            onClick={onPublishAndAdd}
          >
            {publishing ? "Publishing…" : "Publish recipe & add"}
          </Button>
        )}
      </div>
    );
  }

  return (
    <CheckboxRow
      size={size}
      tone="selection"
      checked={filed}
      title={disabledHint}
      // `min-h-11` is belt-and-braces on the mobile size: `default` already
      // measures 48px, and the floor keeps it there if the type scale moves.
      className={size === "default" ? "min-h-11" : undefined}
      meta={`${collection.recipeIds.length}`}
      onCheckedChange={(checked) => {
        if (disabledHint) return;
        onToggle(checked);
      }}
    >
      <span className="block truncate">{collection.name}</span>
    </CheckboxRow>
  );
}
