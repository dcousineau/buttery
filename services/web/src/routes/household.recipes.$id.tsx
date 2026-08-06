import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, UtensilsCrossed } from "lucide-react";
import * as z from "zod";
import { getHouseholdRecipe } from "#/server/household-recipes";
import { Button } from "#/components/ui/button";
import { DetailPane } from "#/components/recipes/DetailPane";

/**
 * The recipe detail child route (plan §5.1). Renders in the ledger's right pane
 * on desktop and full-screen on mobile. Authorization is box membership (not
 * `visibility='public'`), so it can render a recipe whose source has since gone
 * unavailable, from cache. Deep-linkable and readable (path-based, not a query).
 *
 * `?cook=1` opens cook mode immediately (meal planner §7.5) — the planner's
 * "Start cook mode" points here. It is `.catch()`-guarded like every other
 * search param in the app: a mangled value renders the plain page rather than
 * throwing a route error.
 *
 * The union has to cover the number `1` as well as the string: the router
 * JSON-parses search values, so the spec's own `?cook=1` arrives as `1`, not
 * `"1"`, and a string-only union would silently drop it (and, because the parsed
 * search is what the URL is rebuilt from, quietly strip the param too).
 */
const searchSchema = z.object({
  cook: z
    .union([z.boolean(), z.literal(1), z.literal("1"), z.literal("true")])
    .transform((value) => value !== false)
    .optional()
    .catch(undefined),
});

export const Route = createFileRoute("/household/recipes/$id")({
  validateSearch: searchSchema,
  loader: ({ params }) => getHouseholdRecipe({ data: { recipeId: params.id } }),
  component: RecipeDetailRoute,
});

function RecipeDetailRoute() {
  const recipe = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  if (!recipe) return <NotInBox />;
  // Key by recipeId so switching recipes remounts the pane (resets favorite,
  // scroll, and the note editor without any setState-in-effect).
  return (
    <DetailPane
      key={recipe.recipeId}
      recipe={recipe}
      autoOpenCook={search.cook === true}
      // Drop the param once cook mode has been closed, so the deep link is
      // consumed exactly once and a reload does not re-enter the apron.
      onCookModeClosed={() => void navigate({ search: (prev) => ({ ...prev, cook: undefined }), replace: true })}
    />
  );
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
