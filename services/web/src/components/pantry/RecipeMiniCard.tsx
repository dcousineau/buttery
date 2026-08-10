import { Link } from "@tanstack/react-router";
import { Plus, UtensilsCrossed } from "lucide-react";
import type { GlobalRecipeResult, HouseholdRecipeRow } from "#/server/household-recipes";
import { Button } from "#/components/ui/button";
import { Card } from "#/components/ui/card";
import { Spinner } from "#/components/ui/spinner";
import { formatPublished } from "#/lib/format";
import { cn } from "#/lib/utils";

/**
 * The 4:3 recipe tile used by both pantry-home grids — "Fresh in your box" and
 * "Not in your box yet". One component, two variants, because they are the same
 * object seen from two sides: a recipe you keep, and a recipe you could keep.
 * Splitting them into two files was the fastest way to end up with two slightly
 * different cards in one screenful, which is how the recipe slat's docblock
 * describes a design quietly stopping being a design.
 *
 * The variants differ in exactly three places and nowhere else:
 *
 * - **box** — the whole card is a link to `/household/recipes/$id`, and the third
 *   line is provenance *within the household* ("Added by @dana · 2 days ago").
 * - **network** — the card is not a link (there is no household page for a recipe
 *   the household does not keep) but its media and title open a read-only
 *   preview, the third line is the publishing `@handle`, and the action is a
 *   full-width `Save to my box` that the caller owns.
 *
 * `addedByYou` is a prop rather than a comparison done here: the leaf has no idea
 * who is signed in, and handing it a viewer handle to compare against would put
 * session shape into a presentational component. The section above it does the
 * one comparison and passes the answer down.
 *
 * A recipe with no photo gets the design system's stated fallback — a `--muted`
 * panel with Lucide `utensils-crossed` at 2.5rem — not a broken image and not a
 * collapsed box. Hover follows the system's card rule: the card translates -2px
 * on Y only (never X, that is button physics) and the photo scales to 1.03 over
 * 300ms. Both variants lift, because both now go somewhere on a click — the box
 * card to the household's copy, the network card to its preview.
 */

export interface RecipeMiniCardBoxProps {
  variant: "box";
  recipe: HouseholdRecipeRow;
  /** True when the signed-in viewer is the person who added it — renders "you". */
  addedByYou?: boolean;
}

export interface RecipeMiniCardNetworkProps {
  variant: "network";
  recipe: GlobalRecipeResult;
  /** The caller owns `addRecipeToHousehold` and the refetch that follows it. */
  onSave(recipeId: string): void;
  /** Opens the caller's read-only preview. Handed the whole row: the dialog
   * titles itself from the card's copy while the detail fetch is in flight. */
  onPreview(recipe: GlobalRecipeResult): void;
  /** This card's save is in flight: the button reads "Saving…" and is inert. */
  saving?: boolean;
}

export type RecipeMiniCardProps = RecipeMiniCardBoxProps | RecipeMiniCardNetworkProps;

export function RecipeMiniCard(props: RecipeMiniCardProps) {
  return props.variant === "box" ? <BoxCard {...props} /> : <NetworkCard {...props} />;
}

/**
 * The image well. `alt=""` on purpose: the title sits directly underneath, so an
 * alt that repeats it makes a screen reader say the recipe's name twice.
 */
function CardMedia({ src, zoom }: { src: string | null; zoom: boolean }) {
  return (
    <div className="aspect-[4/3] w-full overflow-hidden border-b-2 border-border bg-muted">
      {src ? (
        <img src={src} alt="" loading="lazy" className={cn("h-full w-full object-cover", zoom && "transition-transform duration-300 group-hover/mini:scale-[1.03]")} />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <UtensilsCrossed className="size-10" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

/**
 * `as="span"` is not cosmetic: the network card's title sits inside a `<button>`,
 * whose content model is phrasing only, so a heading there would be invalid
 * markup that assistive tech is free to read either way.
 */
function CardTitleLine({ children, as: Tag = "h3" }: { children: string; as?: "h3" | "span" }) {
  return <Tag className="m-0 block line-clamp-2 text-base leading-snug font-semibold text-foreground text-pretty">{children}</Tag>;
}

function BoxCard({ recipe, addedByYou = false }: RecipeMiniCardBoxProps) {
  // Only what the payload actually carries. The comp's "12 biscuits" comes from a
  // yield field the box row does not have, so the line is time + provenance and
  // nothing invented.
  const meta = [recipe.totalTimeDisplay, recipe.sourceLabel].filter((part): part is string => Boolean(part)).join(" · ");
  const adder = addedByYou ? "you" : recipe.addedByHandle;
  const when = formatPublished(recipe.addedAt);

  return (
    <Card className="group/mini overflow-hidden p-0 transition-transform hover:-translate-y-0.5">
      <Link to="/household/recipes/$id" params={{ id: recipe.recipeId }} className="flex h-full flex-col no-underline">
        <CardMedia src={recipe.thumbUrl} zoom />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 px-4 pt-3.5 pb-4">
          <CardTitleLine>{recipe.title}</CardTitleLine>
          {meta ? <p className="m-0 truncate text-[0.8125rem] text-muted-foreground">{meta}</p> : null}
          <p className="m-0 mt-auto pt-0.5 text-xs text-muted-foreground">
            {adder ? `Added by ${adder} · ` : "Added "}
            <time dateTime={recipe.addedAt}>{when}</time>
          </p>
        </div>
      </Link>
    </Card>
  );
}

function NetworkCard({ recipe, onSave, onPreview, saving = false }: RecipeMiniCardNetworkProps) {
  // `source.label` is the publishing `@handle` whenever the repo resolved, which
  // is also the third line — show it only when it says something different.
  const meta = recipe.source.label && recipe.source.label !== recipe.handle ? recipe.source.label : null;

  // `gap-0` cancels `Card`'s own `--card-spacing` gap: with `p-0` the media and
  // the body are the card's two direct children and must sit flush.
  return (
    <Card className="group/mini gap-0 overflow-hidden p-0 transition-transform hover:-translate-y-0.5">
      {/*
        Media and copy are one button rather than a linked card: there is no page
        to route to, and a preview is a dialog, so the affordance has to be a
        button for the keyboard and the screen reader alike. The `sr-only` verb
        leads so the accessible name says what the control does and still
        contains every word that is visible (WCAG 2.5.3, label in name). The
        focus ring is drawn inside — the card clips anything outside it.
      */}
      <button
        type="button"
        onClick={() => onPreview(recipe)}
        className="flex min-w-0 flex-1 flex-col text-left focus-visible:-outline-offset-3 focus-visible:outline-3 focus-visible:outline-ring"
      >
        <span className="sr-only">Preview </span>
        <CardMedia src={recipe.thumbUrl} zoom />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5 px-4 pt-3.5 pb-2">
          <CardTitleLine as="span">{recipe.title}</CardTitleLine>
          {meta ? <span className="m-0 block truncate text-[0.8125rem] text-muted-foreground">{meta}</span> : null}
          {recipe.handle ? <span className="m-0 block truncate text-xs text-muted-foreground">{recipe.handle}</span> : null}
        </span>
      </button>
      {/*
        Every card in the grid carries the same visible label, so the button
        also names its recipe for anyone reading the page as a list of
        controls. The visible text stays a leading substring of the accessible
        name (WCAG 2.5.3, label in name).
      */}
      <div className="px-4 pt-1.5 pb-4">
        <Button size="sm" className="w-full" disabled={saving} aria-label={`Save to my box: ${recipe.title}`} onClick={() => onSave(recipe.recipeId)}>
          {saving ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" aria-hidden="true" />}
          {saving ? "Saving…" : "Save to my box"}
        </Button>
      </div>
    </Card>
  );
}
