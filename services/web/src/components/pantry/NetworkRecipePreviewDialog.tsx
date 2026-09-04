import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Clock, CookingPot, ExternalLink, Plus, Users, UtensilsCrossed, X } from "lucide-react";
import { type GlobalRecipeResult, getRecipe, type RecipeDetailData } from "#/lib/api";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "#/components/ui/dialog";
import { Separator } from "#/components/ui/separator";
import { Skeleton } from "#/components/ui/skeleton";
import { Spinner } from "#/components/ui/spinner";
import { formatDuration, formatPublished } from "#/lib/format";
import { attributionName } from "#/lib/recipe-provenance";
import { MetaRow, PublisherLink } from "#/components/recipes/RecipeMeta";
import { SourceLink } from "#/components/recipes/SourceLink";

/**
 * A read-only look at a public recipe before it is worth a place in the box —
 * "Not in your box yet" asks people to keep a stranger's recipe on the strength
 * of a thumbnail and a title, which is not enough to judge one by.
 *
 * The layout is the public detail page (`/recipes/$id`) at dialog scale, and
 * deliberately *only* that: no cook mode, no timers, no scaling, no groceries,
 * no edit. Those are affordances of a recipe you own, and offering them on one
 * you don't would be writing a cheque the recipe can't cash. The only controls
 * are close, "Save to my box", and a plain link to the full page — where all of
 * the above genuinely exists.
 *
 * **Fetched on open, never in the route loader.** The pantry renders three of
 * these cards and most visits open none of them, so the detail query is paid
 * for by the person who asks for it. The dialog is titled from the card's own
 * `title` rather than the response, so the dialog has an accessible name from
 * the first frame instead of one that arrives with the data.
 *
 * No JSON-LD or microdata here, unlike the public page: this is the same recipe
 * already published at its own canonical URL, and stamping a second
 * schema.org/Recipe node into `/household` would tell parsers the pantry is a
 * recipe. Attribution and publisher links render as plain text for the same
 * reason the actions are absent — the preview reads, it does not send you
 * anywhere except the recipe's real page.
 */

/** Loading is the entry state; `missing` is a definitive "no such public recipe". */
type PreviewState = { status: "loading" } | { status: "ready"; detail: RecipeDetailData } | { status: "missing" } | { status: "error" };

export interface NetworkRecipePreviewDialogProps {
  /** The card being previewed. `null` is the closed state — there is no second flag. */
  recipe: GlobalRecipeResult | null;
  onOpenChange: (open: boolean) => void;
  /**
   * The route's own `saveToBox`: `addRecipeToHousehold`, then invalidate, then
   * toast. Resolves true when the recipe actually landed, which is the only
   * thing this dialog needs to know — on success the card behind it is about to
   * leave the section, so the preview closes with it.
   */
  onSave: (recipeId: string) => Promise<boolean>;
  /** This recipe's save is in flight. Owned by the route, shared with its card. */
  saving?: boolean;
}

export function NetworkRecipePreviewDialog({ recipe, onOpenChange, onSave, saving = false }: NetworkRecipePreviewDialogProps) {
  // The response is kept *with the row it answers for* rather than as a bare
  // status. That buys two things with one piece of state: "loading" is derived
  // from a mismatch instead of being written by the effect, and the row outlives
  // the caller's `null` — the popup is still mounted for its 150ms exit, and a
  // header that blanked to a placeholder mid-fade would look like a bug.
  const [answer, setAnswer] = useState<{ row: GlobalRecipeResult; state: PreviewState } | null>(null);

  useEffect(() => {
    if (!recipe) return;

    let live = true;
    getRecipe(recipe.recipeId).then(
      (detail) => {
        if (live) setAnswer({ row: recipe, state: detail ? { status: "ready", detail } : { status: "missing" } });
      },
      () => {
        if (live) setAnswer({ row: recipe, state: { status: "error" } });
      },
    );
    return () => {
      live = false;
    };
  }, [recipe]);

  // A closing dialog (`recipe` null) keeps what it was showing on its way out;
  // any other card starts from loading until its own answer arrives.
  const shown = recipe ?? answer?.row ?? null;
  const state: PreviewState = answer && (recipe === null || answer.row.recipeId === recipe.recipeId) ? answer.state : { status: "loading" };

  async function handleSave() {
    if (!recipe || saving) return;
    if (await onSave(recipe.recipeId)) onOpenChange(false);
  }

  return (
    <Dialog open={recipe !== null} onOpenChange={onOpenChange}>
      {/* `gap-0 p-0` cancel the xl popup's padded-stack defaults: the header and
          footer bars are full-bleed rules, and only the middle band scrolls, so
          long recipes stay inside the dialog instead of growing it.
          `overflow-hidden` is what makes full-bleed legal here: those bars are
          square `bg-card` blocks running edge to edge, so without it they paint
          straight over the popup's own `rounded-xl` and all four corners come
          out mitred — the border visibly stops short and squares off. Nothing
          inside draws beyond the popup (the close button's focus ring sits well
          within the padding), so there is nothing for the clip to eat. */}
      <DialogContent size="xl" className="max-h-[calc(100svh-2rem)] gap-0 overflow-hidden p-0 sm:max-h-[calc(100svh-5rem)]">
        <div className="flex flex-none items-start gap-3 border-b-2 border-border bg-card px-5 py-3">
          <div className="min-w-0">
            <Badge size="xs" className="mb-1.5">
              From the network
            </Badge>
            {/* Title only. The publisher's handle is the first thing in the
                body below, so repeating it in the bar just said it twice. */}
            <DialogTitle size="lg" className="line-clamp-2">
              {shown?.title ?? "Recipe"}
            </DialogTitle>
          </div>
          {/* `DialogClose` rather than a button calling `onOpenChange(false)`:
              the primitive owns dismissal and focus restoration, so this button
              and Escape close by exactly the same path. */}
          <DialogClose render={<Button variant="ghost" size="icon-sm" />} className="ml-auto" aria-label="Close the preview">
            <X aria-hidden="true" />
          </DialogClose>
        </div>

        <DialogDescription className="sr-only">A read-only preview. Save it to your box to cook it, plan it or edit it.</DialogDescription>

        {/* The fetch has no visible text of its own until it resolves, so its
            outcome is announced rather than only drawn. */}
        <div className="sr-only" role="status" aria-live="polite">
          {state.status === "loading"
            ? "Loading the recipe…"
            : state.status === "ready"
              ? `${state.detail.name} loaded.`
              : state.status === "missing"
                ? "This recipe is no longer available."
                : "The preview didn't load."}
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
          {state.status === "loading" ? (
            <PreviewSkeleton />
          ) : state.status === "ready" ? (
            <PreviewBody recipe={state.detail} />
          ) : (
            <PreviewMessage
              title={state.status === "missing" ? "This recipe is gone" : "That didn't load"}
              body={
                state.status === "missing"
                  ? "It isn't public anymore — whoever published it may have unpublished or deleted the record."
                  : "The preview couldn't be fetched. Close this and open it again."
              }
            />
          )}
        </div>

        <div className="flex flex-none flex-wrap items-center gap-2 border-t-2 border-border bg-card px-5 py-3">
          <Button onClick={handleSave} disabled={saving || state.status === "missing"}>
            {saving ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" aria-hidden="true" />}
            {saving ? "Saving…" : "Save to my box"}
          </Button>
          {shown ? (
            <Button variant="ghost" nativeButton={false} render={<Link to="/recipes/$id" params={{ id: shown.recipeId }} />}>
              Open the full recipe
              <ChevronRight data-icon="inline-end" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The public detail page's reading order, one step down in scale: who published
 * it, what it is, how long it takes, what goes in, what to do. The two-column
 * splits key off `md` rather than the page's `lg` because the dialog is at most
 * `max-w-4xl` — by the time the viewport is `lg` this content has been in two
 * columns for a while.
 */
function PreviewBody({ recipe }: { recipe: RecipeDetailData }) {
  const hero = recipe.images[0];
  const times = [
    { label: "Prep", value: formatDuration(recipe.prepTime) },
    { label: "Cook", value: formatDuration(recipe.cookTime) },
    { label: "Total", value: formatDuration(recipe.totalTime) },
    // Filter on the formatted value, not on the raw field: `PT0S` is a present
    // field that formats to nothing.
  ].filter((t): t is { label: string; value: string } => t.value !== null);

  const facets = [recipe.cuisine, recipe.category, recipe.cookingMethod, ...recipe.suitableForDiet].filter(Boolean) as string[];
  const attributedTo = attributionName(recipe.attribution);

  return (
    <div className="flex flex-col gap-6">
      <header className="grid gap-5 md:grid-cols-[1.1fr_1fr] md:items-start">
        {/* Photo first on a phone, beside the copy once there is room — the same
            order the public page uses, at the dialog's narrower breakpoint. */}
        <div className="order-1 md:order-2">
          {hero ? (
            <img src={hero.url} alt={hero.alt ?? recipe.name} className="aspect-[4/3] w-full rounded-xl border-2 border-border object-cover shadow-pop-md" />
          ) : (
            <div className="flex aspect-[4/3] w-full items-center justify-center rounded-xl border-2 border-border bg-muted text-muted-foreground shadow-pop-md">
              <UtensilsCrossed className="size-10" aria-hidden="true" />
            </div>
          )}
        </div>

        <div className="order-2 min-w-0 md:order-1">
          <MetaRow className="mb-3 text-sm text-muted-foreground">
            {recipe.source && <SourceLink source={recipe.source} />}
            {recipe.publishedBy && <PublisherLink handle={recipe.publishedBy} url={recipe.publisherUrl} />}
            {recipe.publishedAt && <time dateTime={recipe.publishedAt}>{formatPublished(recipe.publishedAt)}</time>}
          </MetaRow>

          {recipe.description ? <p className="m-0 max-w-prose text-sm text-foreground text-pretty sm:text-base">{recipe.description}</p> : null}

          {times.length > 0 || recipe.recipeYield || recipe.calories != null ? (
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2.5">
              {times.map((t) => (
                <Stat key={t.label} icon={<Clock />} label={t.label} value={t.value} />
              ))}
              {recipe.recipeYield ? <Stat icon={<Users />} label="Yield" value={recipe.recipeYield} /> : null}
              {recipe.calories != null ? <Stat icon={<CookingPot />} label="Calories" value={String(recipe.calories)} /> : null}
            </div>
          ) : null}

          {facets.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {facets.map((f) => (
                <Badge key={f} variant="outline" size="xs">
                  {f}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
      </header>

      <Separator />

      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_1.6fr] md:gap-8">
        <section>
          <h3 className="display-title m-0 text-lg text-foreground">Ingredients</h3>
          {recipe.ingredients.length > 0 ? (
            <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
              {recipe.ingredients.map((ing, i) => (
                <li key={i} className="flex gap-2.5 text-sm leading-snug text-foreground">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                  <span className="min-w-0">{ing}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 mt-3 text-sm text-muted-foreground">No ingredients listed.</p>
          )}
        </section>

        <section>
          <h3 className="display-title m-0 text-lg text-foreground">Instructions</h3>
          {recipe.instructions.length > 0 ? (
            <ol className="m-0 mt-3 flex list-none flex-col gap-4 p-0">
              {recipe.instructions.map((step, i) => (
                <li key={i} className="flex gap-3">
                  <span
                    className="grid size-7 shrink-0 place-content-center rounded-full border-2 border-border bg-secondary text-xs font-bold text-secondary-foreground"
                    aria-hidden="true"
                  >
                    {i + 1}
                  </span>
                  <p className="m-0 min-w-0 pt-0.5 text-sm leading-relaxed text-foreground">{step}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="m-0 mt-3 text-sm text-muted-foreground">No instructions listed.</p>
          )}
        </section>
      </div>

      {recipe.images.length > 1 ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {recipe.images.slice(1).map((img, i) => (
            <img
              key={i}
              src={img.url}
              alt={img.alt ?? `${recipe.name} photo ${i + 2}`}
              loading="lazy"
              className="aspect-[4/3] w-full rounded-xl border-2 border-border object-cover"
            />
          ))}
        </div>
      ) : null}

      {recipe.keywords.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {recipe.keywords.map((k) => (
            <Badge key={k} variant="ghost" size="xs" className="border-border">
              {k}
            </Badge>
          ))}
        </div>
      ) : null}

      {attributedTo ? (
        <footer className="rounded-xl border-2 border-border bg-muted/40 p-4 text-sm text-muted-foreground">
          <p className="m-0">
            <span className="font-semibold text-foreground">Source: </span>
            {/* The one outbound link the preview allows. A scraped recipe's
                source is where it actually came from, and printing the site's
                name as dead text next to a URL we hold is the same lie the
                ledger's provenance label used to tell. */}
            {recipe.attribution?.url ? (
              <a
                href={recipe.attribution.url}
                target="_blank"
                rel="noreferrer noopener nofollow"
                className="inline-flex items-center gap-1 text-primary underline underline-offset-4"
              >
                {attributedTo}
                <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              attributedTo
            )}
            {recipe.attribution?.author && recipe.attribution.displayName ? ` — by ${recipe.attribution.author}` : null}
          </p>
        </footer>
      ) : null}
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="text-sm">
        <span className="font-bold text-foreground">{value}</span> <span className="text-muted-foreground">{label}</span>
      </span>
    </div>
  );
}

/** Shaped like the body it becomes, so the dialog doesn't resize under the pointer. */
function PreviewSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <div className="grid gap-5 md:grid-cols-[1.1fr_1fr] md:items-start">
        <Skeleton className="order-1 aspect-[4/3] w-full rounded-xl md:order-2" />
        <div className="order-2 flex flex-col gap-2.5 md:order-1">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="mt-2 h-4 w-52" />
        </div>
      </div>
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_1.6fr] md:gap-8">
        <div className="flex flex-col gap-2">
          <Skeleton className="mb-1 h-5 w-28" />
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-3.5 w-full" />
          ))}
        </div>
        <div className="flex flex-col gap-3">
          <Skeleton className="mb-1 h-5 w-28" />
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

function PreviewMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-14 text-center">
      <UtensilsCrossed className="size-10 text-muted-foreground" aria-hidden="true" />
      <h3 className="display-title m-0 text-lg text-foreground">{title}</h3>
      <p className="m-0 max-w-[28rem] text-sm text-muted-foreground text-pretty">{body}</p>
    </div>
  );
}
