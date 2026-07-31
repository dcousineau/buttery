import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, UtensilsCrossed } from "lucide-react";
import { getHouseholdRecipe } from "#/server/household-recipes";
import { Button } from "#/components/ui/button";
import { DetailPane } from "#/components/recipes/DetailPane";

/**
 * The recipe detail child route (plan §5.1). Renders in the ledger's right pane
 * on desktop and full-screen on mobile. Authorization is box membership (not
 * `visibility='public'`), so it can render a recipe whose source has since gone
 * unavailable, from cache. Deep-linkable and readable (path-based, not a query).
 */
export const Route = createFileRoute("/household/recipes/$id")({
  loader: ({ params }) => getHouseholdRecipe({ data: { recipeId: params.id } }),
  component: RecipeDetailRoute,
});

function RecipeDetailRoute() {
  const recipe = Route.useLoaderData();
  if (!recipe) return <NotInBox />;
  // Key by recipeId so switching recipes remounts the pane (resets favorite,
  // scroll, and the note editor without any setState-in-effect).
  return <DetailPane key={recipe.recipeId} recipe={recipe} />;
}

function NotInBox() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <UtensilsCrossed className="size-10 text-muted-foreground" aria-hidden="true" />
      <div>
        <h2 className="display-title m-0 text-lg text-foreground">Not in your box</h2>
        <p className="mt-1 mb-0 text-sm text-muted-foreground">This recipe isn't on your household's shelf. Add it from the public collection to read it here.</p>
      </div>
      <Button size="sm" variant="outline" render={<Link to="/household/recipes" />} nativeButton={false}>
        <ArrowLeft data-icon="inline-start" aria-hidden="true" />
        Back to the shelf
      </Button>
    </div>
  );
}
