import type { ReactElement, ReactNode } from "react";
import { Binoculars, WandSparkles } from "lucide-react";
import { mergeRecipeTags, type RecipeTag, type RecipeTagLabel } from "#/lib/recipe-tags";
import { Badge } from "#/components/ui/badge";
import { Infotip, InfotipContent, InfotipTrigger } from "#/components/ui/infotip";
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
      <TagInfotip content={tag.note ?? "Provided by the author"} badge={<Badge variant={variant} size="xs" data-source={tag.source} />}>
        {tag.label}
      </TagInfotip>
    );
  }

  if (tag.source === "llm") {
    // The verdict is always in the badge TEXT (`tag.label`) — the tooltip
    // only adds provenance, never the finding itself, which is what keeps
    // this inside the design system's "no essential info in tooltips" rule.
    // The `sr-only` span still carries the provenance for screen readers,
    // which is the only way they learn the tag was AI-identified at all.
    const tooltipCopy = tag.note ? `Identified by AI — ${tag.note}` : "Identified by AI";
    return (
      <TagInfotip content={tooltipCopy} badge={<Badge variant={variant} size="xs" data-source={tag.source} />}>
        {tag.label}
        <WandSparkles className="text-fuchsia-500 dark:text-fuchsia-300" data-icon="inline-end" aria-hidden="true" />
        <span className="sr-only"> (identified by AI)</span>
      </TagInfotip>
    );
  }

  // Rules classifier: no icon (it isn't a model call, doesn't get the "AI"
  // treatment), but still gets a tooltip — the generic fallback line when the
  // rules pass left no note (it never does today; rows have no `note`)
  const tooltipCopy = tag.note ?? "Detected from the ingredient list by a simple rules-based classifier";
  return (
    <TagInfotip content={tooltipCopy} badge={<Badge variant={variant} size="xs" data-source={tag.source} />}>
      {tag.label}
      <Binoculars className="opacity-50" data-icon="inline-end" aria-hidden="true" />
      <span className="sr-only"> (identified by simple matching)</span>
    </TagInfotip>
  );
}

/**
 * The provenance popup on a derived tag chip.
 *
 * An {@link Infotip}, not a `Tooltip`, and that is not a styling choice: Base
 * UI's tooltip is hover-and-keyboard only by construction, so on iOS there was
 * no way to open this at all — the provenance was unreachable on exactly the
 * devices most likely to be holding this page in a kitchen. `Infotip` is Base
 * UI's own prescribed swap for that (its module doc quotes them) and carries
 * the whole story: tap and hover both open it, focus stays put on hover, and
 * the trigger gets real `aria-expanded` disclosure semantics.
 *
 * Two details this call site owns:
 *
 * `cursor-pointer` is load-bearing, not decoration. Safari only synthesizes a
 * `click` on a non-interactive element that looks clickable, and React
 * delegates its listeners to the root container — without it, an iOS tap on
 * the chip produces `pointerdown` and nothing else.
 *
 * The chip stays a `span`. `InfotipTrigger` would render a `<button>` by
 * default, which crosses `badgeVariants`' `touch:[&:is(a,button)]` 44px floor
 * and would inflate every tag in the strip. That floor is scoped to real
 * buttons on purpose (commit bcf1cfd); a provenance chip is a supplementary
 * affordance, not a primary tap target, so it opts out by staying a span.
 *
 * `nativeButton={false}` is what keeps that span honest, and it is NOT
 * optional: the prop defaults to `true`, and left alone Base UI assumes the
 * element brings its own button semantics. On a span that means no `tabIndex`,
 * no `role`, and no Space/Enter activation — a chip a keyboard user cannot
 * reach. Setting it false makes Base UI supply all three. The floor's selector
 * matches the `:is(a,button)` ELEMENT, not the role, so the chip keeps its
 * size.
 */
function TagInfotip({ content, badge, children }: { content: ReactNode; badge: ReactElement; children: ReactNode }) {
  return (
    <Infotip>
      <InfotipTrigger nativeButton={false} render={badge} className="cursor-pointer touch-manipulation">
        {children}
      </InfotipTrigger>
      <InfotipContent>{content}</InfotipContent>
    </Infotip>
  );
}
