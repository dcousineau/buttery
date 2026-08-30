import { WandSparkles } from "lucide-react";
import { mergeRecipeTags, type RecipeTag, type RecipeTagLabel } from "#/lib/recipe-tags";
import { Badge } from "#/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip";
import { cn } from "#/lib/utils";

/**
 * The tag strip both recipe surfaces render — signed-in `DetailPane` and the
 * public `recipes.$id` page — directly below nutrition. One component so the
 * eventual DetailPane/public-page unification inherits it for free rather than
 * re-deriving it.
 *
 * All the policy (which verdicts become a tag, what they say, author-wins
 * dedupe) lives in {@link mergeRecipeTags}. This component only decides how a
 * `RecipeTag` is *drawn* once that policy has already spoken — variant, icon,
 * tooltip copy. It does not re-read `verdict` or re-derive `label`.
 *
 * Returns `null` when the merged list is empty, same idiom as `NutritionStrip`.
 */
export function RecipeTagStrip({
  author,
  labels,
  className,
}: {
  author: { cuisine: string | null; category?: string | null; cookingMethod?: string | null; diets: string[] };
  labels: RecipeTagLabel[] | null | undefined;
  className?: string;
}) {
  const tags = mergeRecipeTags({ author, labels });
  if (tags.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {tags.map((tag) => (
        <RecipeTagBadge key={tag.key} tag={tag} />
      ))}
    </div>
  );
}

/**
 * One tag, dispatched on `source` — the three cases read top to bottom in
 * ascending "how much explaining does this badge owe the reader" order.
 *
 * `tone` (not `source`) picks the Badge variant: `warning` → `destructive`,
 * everything else → `outline`. Allergens are the only `warning` tone and can
 * be author-, rules-, or LLM-sourced, so the two axes are independent — a
 * destructive LLM allergen tag still gets the WandSparkles treatment.
 *
 * No tag carries `itemProp`. Enrichment is never published (see
 * `server/recipe-enrichment.ts`'s module doc) and must not leak into the
 * page's schema.org microdata — that would assert a fact about the recipe the
 * author never wrote down. Author-declared facets don't get `itemProp` here
 * either; the two call sites already emit the machine-readable `meta` tags for
 * their own raw fields, this strip is the human layer only.
 */
function RecipeTagBadge({ tag }: { tag: RecipeTag }) {
  const variant = tag.tone === "warning" ? "destructive" : "outline";

  if (tag.source === "author") {
    // Plain badge: no tooltip, no icon, nothing to attribute — the author
    // wrote this down themselves.
    return (
      <Badge variant={variant} size="xs" data-source={tag.source}>
        {tag.label}
      </Badge>
    );
  }

  if (tag.source === "llm") {
    // The verdict is always in the badge TEXT (`tag.label`) — the tooltip
    // only adds provenance, never the finding itself, which is what keeps
    // this inside the design system's "no essential info in tooltips" rule.
    // Touch/no-hover devices never see this tooltip; the `sr-only` span is
    // the accepted v1 mitigation, and it also happens to be the only way a
    // screen reader learns the tag was AI-identified at all.
    const tooltipCopy = tag.note ? `Identified by AI — ${tag.note}` : "Identified by AI";
    return (
      <Tooltip>
        <TooltipTrigger render={<Badge variant={variant} size="xs" tabIndex={0} data-source={tag.source} />}>
          {tag.label}
          <WandSparkles data-icon="inline-end" aria-hidden="true" />
          <span className="sr-only"> (identified by AI)</span>
        </TooltipTrigger>
        <TooltipContent>{tooltipCopy}</TooltipContent>
      </Tooltip>
    );
  }

  // Rules classifier: no icon (it isn't a model call, doesn't get the "AI"
  // treatment), but still gets a tooltip — the generic fallback line when the
  // rules pass left no note (it never does today; rows have no `note`) — plus
  // a native `title` carrying the full `method` string (`rules@N`) for anyone
  // inspecting provenance without a mouse hover on the custom tooltip.
  const tooltipCopy = tag.note ?? "Detected from the ingredient list";
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant={variant} size="xs" tabIndex={0} data-source={tag.source} title={tag.method ?? undefined} />}>{tag.label}</TooltipTrigger>
      <TooltipContent>{tooltipCopy}</TooltipContent>
    </Tooltip>
  );
}
