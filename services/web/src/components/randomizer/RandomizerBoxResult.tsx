import { useQuery } from "@tanstack/react-query";
import { householdRecipeQuery, type RandomizerCard } from "#/lib/api";
import { DetailPane } from "#/components/recipes/DetailPane";
import { Spinner } from "#/components/ui/spinner";

/**
 * The box half of the result region (plan §7): fetch the full detail for the
 * drawn card and render `DetailPane` **unchanged**, keyed by `recipeId` so its
 * own mount-focus effect fires on every draw (§6.2).
 *
 * `showBackLink={false}`: this pane's mobile "Back to the shelf" link would
 * navigate away from the randomizer, which has no shelf to go back to (§6.1's
 * doc on the prop).
 *
 * ## Why there is no lightweight card here
 *
 * §7 asks for the pool's lightweight card (title, image, source, time) to fill
 * the gap while the detail query lands. It shipped, and it was a verbatim copy
 * of `DetailPane`'s page container, its `display-title` heading, its
 * `gap-x-2 … text-[0.75rem] font-semibold text-muted-foreground` meta row and
 * its 4:3 image box — which is exactly what §7.2 forbids outright ("do not copy
 * markup out of `DetailPane` … a heading, a meta row"), and for the stated
 * reason: two copies of a recipe header drift, and the copy is the one nobody
 * updates.
 *
 * §7.2's own remedy for that collision is its trigger — extract
 * `RecipeDetailHeader` from `DetailPane` and have both surfaces compose it —
 * and that refactor is a change to `DetailPane`, out of this review's scope.
 * So the placeholder is a plain `Spinner` instead: the same one
 * `RandomizerCorpusResult` shows while ITS recipe loads, which makes the two
 * halves of the result region agree, and which claims nothing about how a
 * recipe is typeset. Locally the gap is under one animation frame; the cost is
 * that on a slow link the title arrives with the body rather than before it.
 * If that cost is judged too high, the fix is §7.2's extraction, not a second
 * copy of the header.
 */
export function RandomizerBoxResult({
  householdId,
  card,
  onResultAction,
}: {
  householdId: string;
  card: RandomizerCard;
  /** §9's `randomizer_result_action`, forwarded to the pane's optional hook. */
  onResultAction: (action: "plan_dialog" | "grocery" | "cook") => void;
}) {
  const { data: recipe, isLoading } = useQuery(householdRecipeQuery(householdId, card.recipeId));

  if (isLoading || recipe === undefined) {
    return (
      <div className="flex h-full items-center justify-center py-16 text-muted-foreground">
        <Spinner className="size-6" />
        <span className="sr-only">Loading {card.title}</span>
      </div>
    );
  }

  // A box card the pool just returned should always resolve — but the box can
  // change under a slow connection (someone else in the household removed it
  // between the roll and this fetch landing). Say so rather than spinning
  // forever; the next roll or filter change will exclude it once the pool
  // refetches.
  if (recipe === null) {
    return (
      <div className="mx-auto max-w-[54rem] px-5 pt-8">
        <p className="m-0 text-sm text-muted-foreground">That recipe isn't in your box any more. Roll again for another.</p>
      </div>
    );
  }

  return <DetailPane key={recipe.recipeId} recipe={recipe} householdId={householdId} showBackLink={false} onResultAction={onResultAction} />;
}
