import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, PackagePlus } from "lucide-react";
import { addRecipeToHousehold, getRecipe, keys, type RandomizerCard } from "#/lib/api";
import { Button } from "#/components/ui/button";
import { Spinner } from "#/components/ui/spinner";
import { RecipeView, recipeViewDataFromDetail } from "#/components/recipes/RecipeView";

/**
 * The corpus half of the result region (plan §4.5, §7.1). A corpus draw is
 * not in the household box, so `DetailPane` (which reads a
 * `HouseholdRecipeDetail`) cannot render it — this renders the presentational
 * `RecipeView` instead, fed by `getRecipe` through `recipeViewDataFromDetail`.
 *
 * One action, exactly: "Add to your box" (§4.5 — the comp's corpus Favourite
 * button is dropped as a bug, since there is no `household_recipe` row to
 * favourite until the recipe is kept). Once keeping succeeds, this invalidates
 * the box + the randomizer pool and calls `onKept` — the parent flips this
 * same drawn card over to `RandomizerBoxResult`, so the box's own actions
 * (favourite, shopping list, meal planner, cook mode) appear immediately with
 * no second roll.
 */
export function RandomizerCorpusResult({ householdId, card, onKept }: { householdId: string; card: RandomizerCard; onKept: () => void }) {
  const queryClient = useQueryClient();
  const [keeping, setKeeping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: recipe, isLoading } = useQuery({
    queryKey: ["randomizer", "corpus-recipe", card.recipeId],
    queryFn: () => getRecipe(card.recipeId),
  });

  async function onAdd() {
    setKeeping(true);
    setError(null);
    try {
      await addRecipeToHousehold(card.recipeId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.household.recipes(householdId) }),
        // The whole randomizer-pool prefix (every filter combination for this
        // household), not one exact key — `keys.household.randomizer` folds
        // filters into the tuple's last element, and this recipe just left
        // the corpus scope and entered the box scope for ALL of them.
        queryClient.invalidateQueries({ queryKey: ["household", householdId, "randomizer"] as const }),
      ]);
      onKept();
    } catch {
      setError("Couldn't add that to your box. Try again.");
    } finally {
      setKeeping(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-[54rem] flex-col gap-3.5 px-5 pt-4 pb-8">
      <div className="flex flex-wrap items-center gap-2.5 rounded-lg border-2 border-border bg-secondary px-3 py-2.5 text-secondary-foreground shadow-pop-sm">
        <Info className="size-[18px] shrink-0" aria-hidden="true" />
        <p className="m-0 text-[0.8125rem] font-semibold">From the public network, not your box. Keep it first — a recipe you haven't kept can't go on the plan or the list yet.</p>
        <Button size="sm" className="ml-auto" disabled={keeping} onClick={onAdd}>
          {keeping ? <Spinner /> : <PackagePlus data-icon="inline-start" aria-hidden="true" />}
          {keeping ? "Adding…" : "Add to your box"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="m-0 text-[0.8125rem] font-semibold text-destructive">
          {error}
        </p>
      )}

      {isLoading || !recipe ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Spinner className="size-6" />
        </div>
      ) : (
        <RecipeView data={recipeViewDataFromDetail(recipe)} />
      )}
    </div>
  );
}
