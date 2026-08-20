import { useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { FolderLock, Plus } from "lucide-react";
import { householdCollectionsQuery } from "#/lib/api";
import { OFFLINE_WRITE_HINT, useIsOnline } from "#/lib/offline/use-online";
import { Badge } from "#/components/ui/badge";
import { cn } from "#/lib/utils";
import { CollectionPickerDialog } from "./CollectionPickerDialog";

/**
 * The collections row on a recipe's detail pane (§7): which shelves this recipe
 * is on, and the way onto another one.
 *
 * Every chip opens the picker, including the ones already filed. That is the
 * spec's call and it is the right one: the chips are a *summary*, and the one
 * thing anyone wants after reading a summary of shelves is to change it. A chip
 * that instead navigated to its collection would make the row half read-out,
 * half navigation, with nothing on it to say which was which.
 *
 * The read is the same cached `householdCollectionsQuery` the tree and the
 * ledger use — memberships are derived client-side by joining it against the
 * recipe id (§5's "this is the single read"), so opening a recipe costs no
 * extra request.
 *
 * TODO(m4): below `md` this row's affordance becomes the full-width "File this
 * recipe" button that opens `FileRecipeSheet` instead of the dialog.
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
  const [pickerOpen, setPickerOpen] = useState(false);

  const filed = collections.filter((collection) => collection.recipeIds.includes(recipeId));

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
