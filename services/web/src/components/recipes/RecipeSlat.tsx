import type * as React from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { selectableRowVariants, type SelectableRowVariants } from "#/components/ui/selectable-row";
import { cn } from "#/lib/utils.ts";

/**
 * The **recipe slat** — the app's one horizontal row for "a recipe, in a column of recipes".
 *
 * A slat is a flush, full-bleed bar: no card, no radius, no outer shadow, a hairline divider
 * to its neighbours, and the butter selection marker from `selectableRowVariants` down its
 * leading edge. That construction is not decoration, it is what makes a *list* — cards in a
 * gapped stack read as N separate objects you compare, slats read as one ledger you scan, and
 * scanning is the job at every place this appears: the recipe box, the bulk-import review
 * list, "Already yours", and "Needs a fix". Those had drifted into three near-identical
 * hand-rolled rows (13px bold vs 14px semibold titles, `border-b-2 border-border/45` vs
 * `border-b border-border/60`, one of them a rounded card with a `pop-md` shadow), which is
 * how a design stops being a design. This file is the row; the panes own everything else.
 *
 * **Why it lives in `components/recipes/` and not `components/ui/`.** The layout is generic
 * but the *slots* are not — a thumbnail, a title that carries state icons, a source line, a
 * tertiary line, and trailing metadata is the shape of a recipe, not of a row. `ui/` stays
 * domain-free; `selectable-row.tsx` is the piece of this that genuinely is domain-free, and
 * the slat composes it rather than restating `bg-accent shadow-selected` a fourth time.
 *
 * ## Container queries, not media queries
 *
 * Every responsive decision here keys off `@container/slat` — the width of the *list*, not of
 * the viewport. That is forced by the call sites: the recipe box ledger is a 360px rail, the
 * "Needs a fix" list is a 320px column, and the import review list is whatever is left of a
 * wide pane. On a 1440px desktop a media query calls all three "large" and pads the 320px
 * column like it has 700px. Viewport width is simply not the signal — the row wants to know
 * how much room *it* got.
 *
 * Three tiers, each named for the thing it buys:
 *
 * - **`@2xs` (288px) — the third line.** `RecipeSlatDetail` (keywords, a footnote) only
 *   appears once the row can afford a third line without the title losing its truncation
 *   budget. Below that the slat is title + meta and nothing else.
 * - **`@xs` (320px) — the trailing column.** `RecipeSlatAside` (total time, a badge, the
 *   chevron) sits at the row's trailing edge from here up. Below it the aside *wraps onto its
 *   own line* rather than being hidden: a 4-character time and an 8-character title fighting
 *   over 240px is worse than two lines, and hiding it would take the information out of the
 *   accessibility tree along with the pixels.
 * - **`@md` (448px) — density.** Gutters go 10px → 16px and the type steps 13/11px → 14/12px.
 *   This is the tier the wide import pane lands in, and it is why that pane keeps the roomier
 *   look it has today while the two narrow rails stay tight.
 *
 * ## Composition
 *
 * ```tsx
 * <RecipeSlatList>                      // the <ul>; establishes @container/slat
 *   <RecipeSlat selected={active}>      // the <li>; divider + selection paint
 *     <Checkbox />                      // optional leading control, OUTSIDE the hit target
 *     <RecipeSlatAction render={<Link />}>
 *       <img className="flex-none" />   // media is the call site's: sizes differ per surface
 *       <RecipeSlatBody>
 *         <RecipeSlatTitle><span className="truncate">{name}</span></RecipeSlatTitle>
 *         <RecipeSlatMeta>{source}</RecipeSlatMeta>
 *         <RecipeSlatDetail>{keywords}</RecipeSlatDetail>
 *       </RecipeSlatBody>
 *       <RecipeSlatAside>{time}</RecipeSlatAside>
 *     </RecipeSlatAction>
 *   </RecipeSlat>
 * </RecipeSlatList>
 * ```
 *
 * Two rules the types cannot enforce. **Text children carry their own `truncate`** — the
 * title and meta are flex lines, and `text-overflow` on a flex container does nothing to its
 * children. **Everything inside `RecipeSlatAction` is a `<span>`**, because the action is
 * usually a `<button>` and a `<div>` inside a button is invalid HTML that browsers silently
 * reparent; the slot components render spans for exactly this reason.
 *
 * Semantics stay with the call site, same as `selectableRowVariants`: a list of links marks
 * its current row `aria-current="page"`, a listbox marks it `aria-selected`. The slat is the
 * bar, not the meaning.
 */

/** The bar itself: flush, divided, and padded on the container's terms. */
const recipeSlatVariants = cva("flex items-center gap-2.5 border-b-2 border-border/45 px-2.5 py-2 @md/slat:gap-3 @md/slat:px-4");

/**
 * The hit target. Focus is an outline drawn *inside* the row rather than around it: slats sit
 * flush edge-to-edge in a scrollport, so an outward ring loses its sides to the clip and its
 * top and bottom to the neighbouring rows' dividers. Kept deliberately unlike the butter
 * selection marker — arrowing through a list puts focus and selection on different rows.
 */
const recipeSlatActionVariants = cva(
  "flex min-w-0 flex-1 flex-wrap items-center gap-2.5 text-left no-underline focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-ring @xs/slat:flex-nowrap @md/slat:gap-3",
);

const recipeSlatTitleVariants = cva("flex min-w-0 items-center gap-1 text-[0.8125rem] leading-tight font-semibold text-foreground @md/slat:text-sm");

/**
 * The second line. Two shapes, because they are read differently: a **label** (a source, an
 * ingredient count) is scanned, so it stays on one line and truncates; **prose** (a validation
 * message) is read, so it wraps, and it takes one step more type at every tier — 11px is fine
 * for "allrecipes.com · 9 ingredients" and mean for a sentence you are being asked to act on.
 */
const recipeSlatMetaVariants = cva("text-muted-foreground", {
  variants: {
    wrap: {
      true: "block text-xs font-medium @md/slat:text-[0.8125rem]",
      false: "block truncate text-[0.6875rem] font-semibold @md/slat:text-xs",
    },
  },
  defaultVariants: { wrap: false },
});

/**
 * The third line — the first thing to go when the container is narrow. `hidden` rather than
 * clipped: a keyword list cut to "chicken, we…" is noise, and the slat would rather show two
 * honest lines than three ragged ones.
 */
const recipeSlatDetailVariants = cva("hidden text-[0.6875rem] text-muted-foreground @2xs/slat:block @md/slat:text-xs", {
  variants: {
    wrap: { true: "", false: "truncate" },
  },
  defaultVariants: { wrap: false },
});

/** Trailing metadata: its own line under the body when narrow, the row's trailing edge above `@xs`. */
const recipeSlatAsideVariants = cva(
  "flex basis-full items-center gap-1.5 text-[0.6875rem] font-bold whitespace-nowrap text-muted-foreground @xs/slat:flex-none @xs/slat:basis-auto @md/slat:text-xs",
);

/**
 * The list. This is the element the container queries measure, so it must be the thing whose
 * width tracks the column — in practice the scrollport itself, or the `<ul>` filling it.
 */
function RecipeSlatList({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul data-slot="recipe-slat-list" className={cn("@container/slat m-0 list-none p-0", className)} {...props} />;
}

function RecipeSlat({ className, selected = false, ...props }: React.ComponentProps<"li"> & SelectableRowVariants) {
  return <li data-slot="recipe-slat" className={cn(recipeSlatVariants(), selectableRowVariants({ selected }), className)} {...props} />;
}

function RecipeSlatAction({ className, render, ...props }: useRender.ComponentProps<"button">) {
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">({ className: cn(recipeSlatActionVariants(), className) }, props),
    render,
    state: { slot: "recipe-slat-action" },
  });
}

function RecipeSlatBody({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="recipe-slat-body" className={cn("flex min-w-0 flex-1 flex-col gap-0.5", className)} {...props} />;
}

function RecipeSlatTitle({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="recipe-slat-title" className={cn(recipeSlatTitleVariants(), className)} {...props} />;
}

function RecipeSlatMeta({ className, wrap = false, ...props }: React.ComponentProps<"span"> & VariantProps<typeof recipeSlatMetaVariants>) {
  return <span data-slot="recipe-slat-meta" className={cn(recipeSlatMetaVariants({ wrap }), className)} {...props} />;
}

function RecipeSlatDetail({ className, wrap = false, ...props }: React.ComponentProps<"span"> & VariantProps<typeof recipeSlatDetailVariants>) {
  return <span data-slot="recipe-slat-detail" className={cn(recipeSlatDetailVariants({ wrap }), className)} {...props} />;
}

function RecipeSlatAside({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="recipe-slat-aside" className={cn(recipeSlatAsideVariants(), className)} {...props} />;
}

export { RecipeSlat, RecipeSlatAction, RecipeSlatAside, RecipeSlatBody, RecipeSlatDetail, RecipeSlatList, RecipeSlatMeta, RecipeSlatTitle };
