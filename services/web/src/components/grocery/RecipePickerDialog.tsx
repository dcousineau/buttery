import { useEffect, useRef, useState } from "react";
import { BookOpenText, UtensilsCrossed } from "lucide-react";
import { type HouseholdRecipeRow, listHouseholdRecipes } from "#/server/household-recipes";
import { Button } from "#/components/ui/button";
import { CheckboxRow } from "#/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";

/**
 * Pick several boxed recipes at once, then hand them to the add preview (D3's
 * fourth source; the other three are one recipe, a plan week, and a typed line).
 *
 * The plan wanted this to "ride the existing recipe-index selection surfaces".
 * It cannot yet: the ledger's `selected` is the current-page highlight, one row
 * at a time, and turning the primary recipes surface into a multi-select mode is
 * a much larger change than this feature needs. So it follows the codebase's
 * other precedent instead — `components/plan/AddEntryDialog.tsx`, which picks
 * any number of boxed recipes with `CheckboxRow` — and lives on the list route,
 * where the blast radius is the feature that asked for it.
 *
 * This dialog does not add anything. It produces a `recipes[]` array and closes;
 * `AddPreviewDialog` still runs, so a multi-recipe add gets the same confirm
 * step (D9) a single recipe does — which matters more here, not less, because
 * five recipes is where consolidation actually does something.
 */

export interface RecipePickerDialogProps {
  open: boolean;
  onClose: () => void;
  /** Fires with the picked recipes, in the order the box lists them. */
  onPicked: (recipes: Array<{ recipeId: string; scale?: number }>) => void;
}

export function RecipePickerDialog({ open, onClose, onPicked }: RecipePickerDialogProps) {
  const [box, setBox] = useState<HouseholdRecipeRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  // One fetch per page load, guarded against React's double-invoked effects.
  const requested = useRef(false);

  useEffect(() => {
    if (!open || requested.current) return;
    requested.current = true;
    listHouseholdRecipes()
      .then(setBox)
      .catch(() => setFailed(true));
  }, [open]);

  // Closing unmounts nothing (the dialog stays rendered), so the selection is
  // cleared on the way out rather than left to greet the next open.
  function close() {
    setSelected(new Set());
    setQuery("");
    onClose();
  }

  function toggle(recipeId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(recipeId)) next.delete(recipeId);
      else next.add(recipeId);
      return next;
    });
  }

  const matches = (box ?? []).filter((row) => row.title.toLowerCase().includes(query.trim().toLowerCase()));
  const count = selected.size;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent size="lg">
        <DialogTitle>Which recipes?</DialogTitle>
        <DialogDescription>Pick as many as you like — you’ll see what lands on the list before anything is added.</DialogDescription>

        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your box" aria-label="Search your box" />

        <div className="flex max-h-[18rem] flex-col gap-1 overflow-auto pr-0.5">
          {matches.map((row) => (
            <CheckboxRow key={row.recipeId} size="sm" checked={selected.has(row.recipeId)} onCheckedChange={() => toggle(row.recipeId)} meta={row.totalTimeDisplay ?? undefined}>
              {row.title}
            </CheckboxRow>
          ))}

          {matches.length === 0 && (
            <div className="flex flex-col items-center gap-1 px-6 py-10 text-center">
              <UtensilsCrossed className="size-8 text-muted-foreground" aria-hidden="true" />
              {box === null && !failed ? (
                <p className="m-0 text-xs text-muted-foreground">Fetching your box…</p>
              ) : failed ? (
                <p className="m-0 text-xs text-muted-foreground">Your box didn’t load. Close this and try again.</p>
              ) : query ? (
                <p className="m-0 text-xs text-muted-foreground">Nothing in your box matches that.</p>
              ) : (
                <>
                  <p className="m-0 text-[0.8125rem] font-bold text-foreground">Your box is empty</p>
                  <p className="m-0 text-xs text-muted-foreground">Add a recipe first and it’ll show up here.</p>
                </>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" onClick={close} />}>Cancel</DialogClose>
          <Button
            disabled={count === 0}
            onClick={() => {
              // Box order, not click order: the preview reads down the list the
              // way the box does, so the same pick always produces the same page.
              onPicked((box ?? []).filter((row) => selected.has(row.recipeId)).map((row) => ({ recipeId: row.recipeId })));
              setSelected(new Set());
              setQuery("");
            }}
          >
            <BookOpenText data-icon="inline-start" aria-hidden="true" />
            {count === 0 ? "Pick some recipes" : `Preview ${count} ${count === 1 ? "recipe" : "recipes"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
