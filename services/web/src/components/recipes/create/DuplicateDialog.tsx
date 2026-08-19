import { useState } from "react";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "#/components/ui/dialog";
import { Button } from "#/components/ui/button";
import { Spinner } from "#/components/ui/spinner";
import { addRecipeToHousehold, keys } from "#/lib/api";

/**
 * Shown when publishing an imported URL that an existing PUBLIC record already
 * cites (plan §dedupe). Offers to open that recipe or add it to the box — never a
 * silent redirect.
 */
export function DuplicateDialog({ open, onOpenChange, existingRecipeId }: { open: boolean; onOpenChange: (o: boolean) => void; existingRecipeId: string | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // The route context, for the same reason `DetailPane` reads it: this dialog
  // only renders under `/household/recipes`, whose `beforeLoad` resolved the id
  // the box query on screen is keyed with.
  const { householdId } = useRouteContext({ from: "/household/recipes" });
  const [adding, setAdding] = useState(false);

  async function open_() {
    if (!existingRecipeId) return;
    onOpenChange(false);
    await navigate({ to: "/household/recipes/$id", params: { id: existingRecipeId } });
  }

  async function addExisting() {
    if (!existingRecipeId) return;
    setAdding(true);
    try {
      await addRecipeToHousehold(existingRecipeId);
      // Same invalidation every other add path does. Without it the ledger —
      // whose loader is `ensureQueryData` and whose observer never unmounts
      // under this layout — keeps the pre-add list until some later refetch,
      // showing a box the recipe just landed in without the recipe.
      void queryClient.invalidateQueries({ queryKey: keys.household.recipes(householdId) });
      onOpenChange(false);
      await navigate({ to: "/household/recipes/$id", params: { id: existingRecipeId } });
    } finally {
      setAdding(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Someone already published this one</DialogTitle>
        <DialogDescription>A public recipe on atproto already credits this page. Rather than publish a duplicate, open it or add the existing one to your box.</DialogDescription>
        <DialogFooter className="sm:justify-between">
          <DialogClose render={<Button variant="ghost" disabled={adding} />}>Cancel</DialogClose>
          <div className="flex gap-2">
            <Button variant="outline" onClick={addExisting} disabled={adding}>
              {adding && <Spinner data-icon="inline-start" />}
              Add it to my box
            </Button>
            <Button onClick={open_} disabled={adding}>
              Open the recipe
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
