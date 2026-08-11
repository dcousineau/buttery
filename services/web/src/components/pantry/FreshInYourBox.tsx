import { useId } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Plus } from "lucide-react";
import type { HouseholdRecipeRow } from "#/server/household-recipes";
import { Button } from "#/components/ui/button";
import { RecipeMiniCard } from "./RecipeMiniCard";
import { cn } from "#/lib/utils";

/**
 * "Fresh in your box" — the last few recipes the household added, as a grid of
 * box-variant `RecipeMiniCard`s.
 *
 * The caller decides what "fresh" means and how many rows fit: this renders the
 * array it is given, in the order it is given, and does no slicing or sorting of
 * its own. Sorting here would put a second, invisible opinion about recency next
 * to the loader's, and the two would eventually disagree.
 *
 * `Add a recipe` is a callback, not a link. Adding a recipe is a chooser dialog
 * the recipes route already owns (`AddRecipeChooser` → paste a link / write one /
 * browse the network); duplicating any of that here would fork the flow. `All
 * recipes` is a real link, because it really is a navigation.
 *
 * `viewerHandle` is compared once, here, to decide which cards say "Added by
 * you". The card itself takes the boolean — a leaf tile has no business knowing
 * the shape of a session.
 */

export interface FreshInYourBoxProps {
  /** Already ordered and trimmed by the caller — rendered as given. */
  recipes: HouseholdRecipeRow[];
  /** The viewer's "@handle" (prefixed, as the server returns it), or null. */
  viewerHandle: string | null;
  /** Opens the route's add-a-recipe chooser. This section opens nothing itself. */
  onAddRecipe: () => void;
  className?: string;
}

export function FreshInYourBox({ recipes, viewerHandle, onAddRecipe, className }: FreshInYourBoxProps) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className={cn("flex flex-col gap-4", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="display-title m-0 text-2xl text-foreground">
          Fresh in your box
        </h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onAddRecipe}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            Add a recipe
          </Button>
          <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/household/recipes" />}>
            All recipes
            <ChevronRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4">
        {recipes.map((recipe) => (
          <RecipeMiniCard key={recipe.recipeId} variant="box" recipe={recipe} addedByYou={viewerHandle !== null && recipe.addedByHandle === viewerHandle} />
        ))}
      </div>
    </section>
  );
}
