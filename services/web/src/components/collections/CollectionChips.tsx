import { useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { FolderLock, Plus } from "lucide-react";
import { householdCollectionsQuery } from "#/lib/api";
import { OFFLINE_WRITE_HINT, useIsOnline } from "#/lib/offline/use-online";
import { useIsMobile } from "#/lib/hooks/use-mobile";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import { CollectionPickerDialog } from "./CollectionPickerDialog";
import { FileRecipeSheet } from "./FileRecipeSheet";

/**
 * The collections row on a recipe's detail pane (§7): which collections this
 * recipe is on, and the way onto another one.
 *
 * **Two shapes, one job.** On a desktop every chip opens the picker dialog,
 * including the ones already filed — the chips are a *summary*, and the one
 * thing anyone wants after reading a summary of collections is to change it.
 * Below `md` the chips stop being buttons and a **"File this recipe"** button
 * appears beside them, opening `FileRecipeSheet`: a phone has no drag and no
 * collections column, so this button is the whole way into a collection from a
 * recipe, and an `xs` chip is not a thing you ask a thumb to hit for it.
 *
 * That button is a **peer of the pane's other recipe actions**, not a banner
 * over them: "Add to shopping list" and "Add to meal planner" sit directly
 * underneath it in `DetailPane`, and they are default-size `outline` buttons
 * with a leading icon. This one is the same button in the same flex flow, so
 * the three read as one set of things you can do with this recipe rather than
 * one loud one and two quiet ones.
 *
 * The read is the same cached `householdCollectionsQuery` the tree and the
 * ledger use — memberships are derived client-side by joining it against the
 * recipe id (§5's "this is the single read"), so opening a recipe costs no
 * extra request.
 */
export function CollectionChips({
  householdId,
  recipeId,
  recipeTitle,
  recipeUnpublished,
  className,
}: {
  householdId: string;
  recipeId: string;
  recipeTitle: string;
  recipeUnpublished: boolean;
  className?: string;
}) {
  const { data: collections } = useSuspenseQuery(householdCollectionsQuery(householdId));
  const online = useIsOnline();
  const isMobile = useIsMobile();
  const [pickerOpen, setPickerOpen] = useState(false);

  const filed = collections.filter((collection) => collection.recipeIds.includes(recipeId));

  if (isMobile) {
    return (
      // `gap-2`, like the action row below it, so the button lines up with the
      // set it belongs to whether the chips wrap it onto its own line or not.
      <div className={cn("flex flex-wrap items-center gap-2", className)}>
        {filed.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <FolderLock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">Collections:</span>
            {filed.map((collection) => (
              // Read-out, not a control: the button beside them is the one
              // target, and two ways to open the same sheet on one row is a row
              // that has to explain itself.
              <Badge key={collection.id} size="xs" variant="secondary">
                {collection.name}
              </Badge>
            ))}
          </div>
        )}

        {/* Deliberately no size or width of its own: default `outline` is
          exactly what "Add to shopping list" and "Add to meal planner" are in
          the action row below, and this button is one of them. */}
        <Button
          variant="outline"
          disabled={!online}
          title={online ? undefined : OFFLINE_WRITE_HINT}
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen(true)}
        >
          <FolderLock data-icon="inline-start" aria-hidden="true" />
          File this recipe
        </Button>

        <FileRecipeSheet
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          householdId={householdId}
          recipeId={recipeId}
          recipeTitle={recipeTitle}
          recipeUnpublished={recipeUnpublished}
        />
      </div>
    );
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <FolderLock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="sr-only">Collections:</span>

      {filed.map((collection) => (
        <Badge key={collection.id} size="xs" variant="secondary" render={<button type="button" onClick={() => setPickerOpen(true)} />} className="cursor-(--cursor-interactive)">
          {collection.name}
        </Badge>
      ))}

      <Badge
        size="xs"
        variant="outline"
        render={<button type="button" disabled={!online} onClick={() => setPickerOpen(true)} />}
        title={online ? undefined : OFFLINE_WRITE_HINT}
        className="cursor-(--cursor-interactive) text-muted-foreground not-disabled:hover:bg-accent disabled:opacity-60"
      >
        <Plus data-icon="inline-start" aria-hidden="true" />
        {filed.length === 0 ? "Add to a collection" : "Edit"}
      </Badge>

      <CollectionPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        householdId={householdId}
        recipeId={recipeId}
        recipeTitle={recipeTitle}
        recipeUnpublished={recipeUnpublished}
      />
    </div>
  );
}
