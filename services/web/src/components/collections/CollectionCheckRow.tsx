import { Lock } from "lucide-react";
import type { CollectionSummary } from "#/lib/api";
import { CheckboxRow } from "#/components/ui/checkbox";
import { cn } from "#/lib/utils";

/**
 * One shelf, as a tickable row — the shared body of the desktop picker dialog
 * and the mobile "File this recipe" sheet.
 *
 * It exists because both surfaces answer the same question ("which shelves does
 * this recipe belong on?") and both have to refuse the same case: a published
 * collection may not hold a private recipe (§2.4). That refusal is the row
 * milestone 5 hangs its "Publish recipe & add" action off, and two copies of it
 * would mean M5 has to find both. One row, one place.
 *
 * The tick is `tone="selection"`, not the checklist's strike-through: membership
 * is a standing fact, not finished work, and a shelf struck through reads as
 * "removed" (see `ui/checkbox.tsx`).
 */
export function CollectionCheckRow({
  collection,
  filed,
  /** A private recipe against a published shelf — the §2.4 refusal. */
  blocked,
  size,
  disabledHint,
  onToggle,
}: {
  collection: CollectionSummary;
  filed: boolean;
  blocked: boolean;
  /** `sm` in the desktop dialog; `default` on mobile, where the row is ≥44px. */
  size: "sm" | "default";
  /** Non-null disables the tick and explains why (offline). */
  disabledHint?: string;
  onToggle: (checked: boolean) => void;
}) {
  if (blocked) {
    return (
      // TODO(m5): this row gains the "Publish recipe & add" action, which
      // publishes the recipe and files it in one call
      // (`addRecipesToCollection`'s `publishRecipeIds`).
      <div
        className={cn(
          "flex w-full items-center gap-3 rounded-lg border-2 border-dashed border-border/60 bg-muted/40 text-sm text-muted-foreground",
          size === "sm" ? "px-2.5 py-2" : "min-h-11 px-3 py-2.5",
        )}
      >
        <Lock className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{collection.name}</span>
          <span className="block text-xs">Published shelf — this recipe is still private, so it can’t go on it yet.</span>
        </span>
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
