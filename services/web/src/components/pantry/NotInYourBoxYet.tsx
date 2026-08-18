import { useId } from "react";
import { ChevronRight } from "lucide-react";
import type { GlobalRecipeResult } from "#/lib/api";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { RecipeMiniCard } from "./RecipeMiniCard";
import { cn } from "#/lib/utils";

/**
 * "Not in your box yet" — public recipes from the wider atproto network, as a
 * grid of network-variant `RecipeMiniCard`s.
 *
 * The section is a muted panel with one gingham band across its top. Gingham is
 * **trim, not wallpaper** (BRAND.md): one 14px band marks this block as "from
 * outside the household" and nothing else on the page wears it. A gingham field
 * behind the cards would put a red check pattern behind recipe content, which
 * the design system forbids outright.
 *
 * Saving is a callback. `addRecipeToHousehold` is a mutation with a refetch and a
 * toast behind it, and the route owns all three; this section owns only which
 * card looks busy while it happens. `savingRecipeId` rather than a boolean so a
 * second click on a different card cannot make the whole grid look pending.
 *
 * Previewing is a callback for the same reason: the dialog fetches the full
 * recipe and offers the same save, so it belongs beside the mutation at the
 * route rather than one copy per card inside this grid.
 */

export interface NotInYourBoxYetProps {
  /** Already ordered and trimmed by the caller — rendered as given. */
  recipes: GlobalRecipeResult[];
  /** The route calls `addRecipeToHousehold` and owns the toast + invalidate. */
  onSave: (recipeId: string) => void;
  /** Opens the route's read-only preview dialog for one card. */
  onPreview: (recipe: GlobalRecipeResult) => void;
  /** The one card whose save is in flight, or null. */
  savingRecipeId?: string | null;
  /** Opens the route's browse-the-network surface (the global recipe picker). */
  onSeeMore: () => void;
  className?: string;
}

export function NotInYourBoxYet({ recipes, onSave, onPreview, savingRecipeId = null, onSeeMore, className }: NotInYourBoxYetProps) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className={cn("overflow-hidden rounded-xl border-2 border-border bg-muted/45", className)}>
      <div className="gingham-band" aria-hidden="true" />
      <div className="flex flex-col gap-4 p-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="min-w-0">
            <Badge className="mb-2">From the network</Badge>
            <h2 id={headingId} className="display-title m-0 text-2xl text-foreground">
              Not in your box yet
            </h2>
            <p className="mt-2 mb-0 max-w-[34rem] text-sm text-muted-foreground text-pretty">
              Published to atproto by people outside your household. Save one and it becomes yours — copied into your own account, yours to edit.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onSeeMore}>
            See more
            <ChevronRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4">
          {recipes.map((recipe) => (
            <RecipeMiniCard key={recipe.recipeId} variant="network" recipe={recipe} onSave={onSave} onPreview={onPreview} saving={savingRecipeId === recipe.recipeId} />
          ))}
        </div>
      </div>
    </section>
  );
}
