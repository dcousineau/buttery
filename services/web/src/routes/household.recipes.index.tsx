import { createFileRoute } from "@tanstack/react-router";
import { UtensilsCrossed } from "lucide-react";
import { Button } from "#/components/ui/button";
import { useRecipesView } from "#/components/recipes/context";

/**
 * The detail pane's empty state (plan §5.3) — shown at `/household/recipes` with
 * no recipe selected. Supersedes the handoff's "auto-select first recipe": the
 * invitation to select/add is always the first thing shown. This is distinct
 * from the box-empty state (which owns the whole ledger when there are no rows).
 */
export const Route = createFileRoute("/household/recipes/")({
  component: DetailEmptyState,
});

function DetailEmptyState() {
  const { openAddChooser } = useRecipesView();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <UtensilsCrossed className="size-10 text-muted-foreground" aria-hidden="true" />
      <div>
        <h2 className="display-title m-0 text-lg text-foreground">Pick a recipe from the shelf</h2>
        <p className="mt-1 mb-0 text-sm text-muted-foreground">Select a recipe on the left to read it here.</p>
      </div>
      <Button size="sm" onClick={openAddChooser}>
        + Add
      </Button>
    </div>
  );
}
