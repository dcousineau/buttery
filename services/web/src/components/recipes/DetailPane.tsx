import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useCanGoBack, useRouter } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CalendarRange, Clock, EyeOff, Settings2, ShoppingBasket, Star, Trash2, UtensilsCrossed } from "lucide-react";
import { useAnalytics } from "#/lib/analytics";
import { type HouseholdRecipeDetail, keys, publishRecipe, removeRecipeFromHousehold, toggleRecipeFavoriteMutation, upsertHouseholdRecipeNote } from "#/lib/api";
import { OFFLINE_WRITE_HINT, useIsOnline } from "#/lib/offline/use-online";
import { Button } from "#/components/ui/button";
import { Img } from "#/components/ui/img";
import { Textarea } from "#/components/ui/textarea";
import { ConfirmDialog } from "#/components/ConfirmDialog";
import { AddToPlanDialog, type AddToPlanRequest } from "#/components/plan/AddToPlanDialog";
import { AddPreviewDialog, type AddPreviewRequest } from "#/components/grocery/AddPreviewDialog";
import { CollectionChips } from "#/components/collections/CollectionChips";
import { MetaRow } from "#/components/recipes/RecipeMeta";
import { summarizeGroceryAdd } from "#/components/grocery/added-summary";
import { SLOT_LABELS, formatPlanDate, shortDow } from "#/lib/plan/labels";
import type { MealSlot, PlanDate } from "#/lib/plan/week";
import { scaleIngredients } from "#/lib/recipe-scale";
import { cn } from "#/lib/utils";
import { useHydratedSession } from "#/lib/auth-client";
import { reconnectAtproto } from "#/lib/atproto-reauth";
import { useRecipesView } from "./context";
import { useRecipeScale } from "./scale";
import { SourceLink } from "./SourceLink";
import { ScalePanel } from "./ScalePanel";
import { NutritionStrip } from "./NutritionStrip";
import { RecipeTagStrip } from "./RecipeTagStrip";
import { UnavailableBanner } from "./UnavailableBanner";
import { StepText } from "./StepText";
import { CookModeLauncher } from "./CookModeLauncher";
import { RecipeTimerStrip } from "#/components/timers/RecipeTimerStrip";

/**
 * The recipe detail pane (right column; full screen on mobile). Reads the shared
 * scale/units prefs and the picker/toast handles from the recipes shell. Favorite
 * and the shared note are server-persisted (optimistic UI); the scale/units
 * settings are ephemeral reading prefs. Shopping and planner both open a
 * confirm dialog and persist; the apron is still stubbed (toast, no persistence).
 */
/**
 * Is this the server refusing a removal because autoimport pins the recipe?
 *
 * Two shapes, because the answer depends on how far the error travelled: a
 * same-process call keeps the `AutoimportProtectedError` instance and its
 * `code`, while one that crossed the server-function boundary arrives as a
 * plain `Error` carrying only the message.
 */
function isAutoimportProtected(err: unknown): boolean {
  if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "autoimport_protected") return true;
  return err instanceof Error && err.message.includes("Autoimport My Recipes");
}

export function DetailPane({
  recipe,
  householdId,
  autoOpenCook = false,
  analyticsSurface = "recipe_detail",
  onCookModeClosed,
  showBackLink = true,
  onResultAction,
}: {
  recipe: HouseholdRecipeDetail;
  /**
   * The cache partition every key below is built from — the value the
   * surrounding route's `beforeLoad` already resolved, passed explicitly rather
   * than read back out of the route context.
   *
   * It used to be `useRouteContext({ from: "/household/recipes" })`, which
   * pinned this pane to one route id. The randomizer renders the same pane from
   * `/household/randomizer` (randomizer plan §6.1), and a second route id is not
   * something a `from` literal can express. The reasoning that put it in route
   * context in the first place is unchanged and still binding on callers:
   *
   * Route context and `useActiveHouseholdId()` name the same household when
   * everything is working, but they fail differently, and the difference is a
   * silent one here. The hook reads the better-auth session (with the
   * localStorage snapshot behind it) and answers `null` until `/get-session`
   * lands — and permanently if that request fails. A `null` id makes every key
   * below unbuildable, so `invalidateBox()` returned early and the ledger simply
   * never updated after a favourite, with no error anywhere. So callers MUST
   * pass the id their route resolved and keyed their queries with — never the
   * hook.
   */
  householdId: string;
  /** `?cook` — the external deep link straight into cook mode (meal planner §7.5). */
  autoOpenCook?: boolean;
  /**
   * Which surface this pane is mounted on, for the `source:` field of the
   * events the pane sends itself (`meal_plan_entry_added`,
   * `grocery_items_added`, and the apron's `cook_mode_opened` below).
   *
   * This pane renders on more than one surface now — `/household/recipes/$id`
   * and the randomizer — and those `source:` values used to be the literal
   * `"recipe_detail"` on both. A grocery add made from the randomizer was
   * therefore reported as a recipe-page add, which is worse than a missing
   * event: the number looks right and is attributed to the wrong surface.
   *
   * Defaulted to today's value, not a fork, so `/household/recipes/$id`'s
   * events are byte-for-byte what they were.
   *
   * Separate from `onResultAction` below, which answers a different question —
   * see its doc.
   */
  analyticsSurface?: string;
  onCookModeClosed?: () => void;
  /**
   * The mobile-only "Back to the shelf" link. On by default, because every
   * surface that had this pane before was reached *from* the shelf. The
   * randomizer sets it `false`: its controls sit directly above the result in
   * one scrolling column, so there is no other pane to go back to and the link
   * would navigate away from the surface instead of up it (randomizer §7.2 —
   * an optional prop defaulted to today's behaviour, not a fork).
   */
  showBackLink?: boolean;
  /**
   * Fired when the reader acts on this recipe, so a surface that renders this
   * pane can record the action under its own event name — the randomizer's
   * `randomizer_result_action` (randomizer plan §9), which no event this pane
   * already sends can stand in for.
   *
   * Optional and unset on `/household/recipes/$id`, so that surface is
   * unchanged: the pane keeps sending its own `meal_plan_entry_added` /
   * `grocery_items_added` / `cook_mode_opened` events either way, and this is
   * additional rather than a replacement. It reports the GESTURE (a dialog was
   * opened, cook mode was launched), not the outcome — the outcome already has
   * an event, and a surface asking "did anyone act on what we suggested?" wants
   * to count the reach for the list, not only the confirmed adds.
   *
   * Deliberately NOT the same thing as `analyticsSurface` above, which is the
   * separate fix for those captures' formerly-hardcoded `source:`. That one
   * says which surface the PANE's own events came from; this one produces the
   * event §9 names, under the CALLER's name, which no event the pane sends can
   * stand in for. Two problems, two fixes, and both exist.
   */
  onResultAction?: (action: "plan_dialog" | "grocery" | "cook") => void;
}) {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const queryClient = useQueryClient();
  // M1 writes are online-only (§4.1): the affordance disables rather than
  // queuing, because the favourite toggle is server-side (so replaying it flips
  // twice) and the note is the field two humans erase each other on. Both get
  // their offline story in M2/M3, with the machinery that makes them safe.
  const online = useIsOnline();
  const { posthog } = useAnalytics();
  const { pushToast } = useRecipesView();
  const { factor, setFactor, metric, setMetric } = useRecipeScale();
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Move focus to the recipe title when the pane mounts. The pane is keyed by
  // recipeId at the render site, so this fires on every selection — restoring
  // focus that would otherwise be lost to <body> (the tapped ledger row is
  // hidden on mobile). `preventScroll` keeps the pane pinned to the top.
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  const [scaleOpen, setScaleOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [publishing, setPublishing] = useState(false);
  // Publishing was refused because this account's atproto grant predates the
  // scopes the PDS write needs; only a fresh authorization fixes it.
  const [needsReauth, setNeedsReauth] = useState(false);
  const [reauthPending, setReauthPending] = useState(false);
  const [planRequest, setPlanRequest] = useState<AddToPlanRequest | null>(null);
  const [listRequest, setListRequest] = useState<AddPreviewRequest | null>(null);
  // `handle` is an atproto-plugin column, absent from better-auth's base user type.
  const { data: session } = useHydratedSession() as { data: { user?: { handle?: string | null } } | null };
  /** "@chef.test" — the account a publish writes to, and publishes from after. */
  const myHandle = session?.user?.handle ? `@${session.user.handle}` : null;

  // Detail-pane state (scroll position, note draft) is keyed by recipeId at the
  // render site (`<DetailPane key={recipe.recipeId} …/>`), so switching recipes
  // remounts this pane and everything resets naturally, with no
  // setState-in-effect. The star is *not* in that list any more: it reads
  // `recipe.favorite` straight off the cache entry the mutation patches, so
  // there is no second copy of the fact to keep in step.

  const scaledIngredients = useMemo(() => scaleIngredients(recipe.ingredients, factor, metric), [recipe.ingredients, factor, metric]);
  const displayServings = recipe.serves != null ? Math.max(1, Math.round(recipe.serves * factor)) : null;
  const primaryImage = recipe.images[0] ?? null;

  const scaleActive = factor !== 1 || metric;
  const scaleLabel = scaleActive ? `${factor}× · ${metric ? "metric" : "US"}` : "Scale & convert";

  // §7.2 (D8): removing a planned recipe is allowed, never blocked — the plan
  // entry points at the rendered `recipe` row, not at the box row, so it keeps
  // rendering and linking out. Warn only when a meal is still ahead; a recipe
  // that was only ever planned in the past needs no extra ceremony.
  const planned = recipe.plannedUsage;
  const plannedAhead = (planned?.upcoming ?? 0) > 0;
  const nextPlannedLabel = planned?.nextDate ? `${shortDow(planned.nextDate)}, ${formatPlanDate(planned.nextDate)}` : null;

  // Autoimport pins a recipe published by a member of this household: the
  // server refuses the removal (`autoimport_protected`) because the next sweep
  // would re-import it anyway. Say so where the button is, rather than letting
  // the press be how you find out. Optional field — a payload cached in
  // IndexedDB before this shipped has no key, and reads as unpinned.
  const autoimportLock = recipe.autoimportLock ?? null;
  const removeBlockedReason = autoimportLock
    ? autoimportLock.isSelf
      ? "You published this recipe, and your Autoimport My Recipes setting keeps it in the box. Turn that off in household settings to remove it."
      : `${autoimportLock.handle ?? "The person who published this"} published this recipe and is in this household with Autoimport My Recipes on, so it stays in the box.`
    : null;

  /** The box list and this recipe's detail — the two entries every write here touches. */
  async function invalidateBox() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.household.recipes(householdId) }),
      queryClient.invalidateQueries({ queryKey: keys.household.recipe(householdId, recipe.recipeId) }),
    ]);
  }

  /**
   * The star, through the port's mutation rather than a local `useState` plus a
   * bare transport call.
   *
   * The hand-rolled version held `favorite` in component state, which made this
   * pane the only place in the app where the star was true and the cache entry
   * behind it still said false — so the ledger row two hundred pixels to the
   * left stayed unstarred until an invalidation landed. `toggleRecipeFavoriteMutation`
   * patches both entries in `onMutate` (see `lib/api/mutations.ts`), so the star
   * below just reads `recipe.favorite` and both surfaces flip on the same frame.
   */
  const favoriteMutation = useMutation(toggleRecipeFavoriteMutation(queryClient, householdId));

  function onFavorite() {
    favoriteMutation.mutate(
      { recipeId: recipe.recipeId, favorite: !recipe.favorite },
      { onSuccess: (result) => posthog.capture("recipe_favorite_toggled", { recipe_id: recipe.recipeId, favorited: result.favorite }) },
    );
  }

  async function onReconnect() {
    setReauthPending(true);
    const failure = await reconnectAtproto(session?.user?.handle);
    // Only reached when the redirect didn't happen.
    if (failure) {
      setReauthPending(false);
      setNeedsReauth(false);
      pushToast(failure);
    }
  }

  async function onPublish() {
    setPublishing(true);
    try {
      const res = await publishRecipe(recipe.recipeId);
      if (res.status === "publish_disabled") {
        pushToast("Publishing is turned off right now.");
        return;
      }
      if (res.status === "reauth_required") {
        // Grant predates the scopes publishing needs — the recipe stays private
        // until the user re-authorizes.
        posthog.capture("recipe_publish_reauth_required", { recipe_id: recipe.recipeId, missing_scope: res.missingScope });
        setNeedsReauth(true);
        return;
      }
      posthog.capture("recipe_published", { recipe_id: recipe.recipeId, from: "detail_lock" });
      await invalidateBox();
    } finally {
      setPublishing(false);
      setConfirmPublish(false);
    }
  }

  async function onPlanned(date: PlanDate, slot: MealSlot) {
    posthog.capture("meal_plan_entry_added", { recipe_id: recipe.recipeId, slot, source: analyticsSurface });
    pushToast(`Added to ${SLOT_LABELS[slot].toLowerCase()} on ${formatPlanDate(date)}`);
    // Three entries move on this write, not two. The box pair, because the
    // pane's "on your meal plan" line comes from the detail payload's
    // `plannedUsage` — *and* the plan itself, which is where the meal actually
    // landed. Skipping the plan used to be defensible when `/household/plan`
    // re-ran a loader on every visit; now that it reads a cached query, an
    // un-invalidated week means walking over to the planner inside its 30s
    // `staleTime` and not finding the meal you just added, with nothing
    // scheduled to correct it. The date can be any week, so this is the whole
    // plan prefix (`keys.household.planAll`, which also covers the `"current"`
    // spelling of whichever week it belongs to).
    await Promise.all([invalidateBox(), queryClient.invalidateQueries({ queryKey: keys.household.planAll(householdId) })]);
  }

  async function onRemove() {
    setRemoving(true);
    try {
      await removeRecipeFromHousehold(recipe.recipeId);
      posthog.capture("recipe_removed_from_household", { recipe_id: recipe.recipeId, planned_upcoming: planned?.upcoming ?? 0 });
      await router.navigate({ to: "/household/recipes" });
      await invalidateBox();
    } catch (err) {
      // The button is disabled whenever this pane knows the recipe is pinned,
      // so getting here means the payload was stale (autoimport turned on in
      // another session, or a pre-feature entry out of IndexedDB). Say why and
      // refetch, rather than closing the dialog as if the removal worked.
      if (!isAutoimportProtected(err)) throw err;
      pushToast("That recipe stays in the box — its publisher has Autoimport My Recipes on.");
      await invalidateBox();
    } finally {
      setRemoving(false);
      setConfirmRemove(false);
    }
  }

  return (
    <div className="flex flex-col md:min-h-0 md:flex-1 md:overflow-auto">
      <div className="mx-auto flex max-w-[54rem] flex-col gap-3.5 px-5 pt-4 pb-8">
        {/* Mobile back affordance. `search: (prev) => prev` keeps the collection
          or smart scope you came from (collections plan §7) — going back to "the
          shelf" should land on the shelf you were on, not the whole box.

          A plain click pops history instead of navigating forward, because below
          `lg` the shelf scrolls the *window*: a forward navigation is a new
          history entry with nothing cached, so it lands at the top of a
          200-row list, while a pop restores the offset the router snapshotted
          on the way out. It stays a real `<Link>` — the href, the middle-click
          and the modifier clicks are all still the shelf — and falls back to
          navigating when there is nothing to pop (a deep link, a refresh). */}
        {showBackLink && (
          <Link
            to="/household/recipes"
            search={(prev) => prev}
            onClick={(event) => {
              if (!canGoBack || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              router.history.back();
            }}
            className="flex w-fit items-center gap-1 text-xs font-semibold text-muted-foreground no-underline hover:text-foreground lg:hidden"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            Back to the shelf
          </Link>
        )}

        {recipe.unavailable && <UnavailableBanner since={recipe.unavailableSince} />}

        {/* Title block */}
        <div className="flex flex-col gap-1.5">
          <h1 ref={titleRef} tabIndex={-1} className="display-title m-0 text-[1.625rem] leading-[1.1] text-balance text-foreground outline-none">
            {recipe.title}
          </h1>
          <MetaRow className="gap-x-2 text-[0.75rem] font-semibold text-muted-foreground">
            {recipe.unpublished && (
              <button
                type="button"
                onClick={() => setConfirmPublish(true)}
                disabled={!online}
                title={online ? undefined : OFFLINE_WRITE_HINT}
                className="inline-flex items-center gap-1 rounded-4xl border-2 border-border bg-secondary px-2 py-0.5 text-secondary-foreground transition-colors not-disabled:hover:bg-accent disabled:opacity-60"
              >
                <EyeOff className="size-3" aria-hidden="true" />
                Private · Publish
              </button>
            )}
            {recipe.source && <SourceLink source={recipe.source} />}
            {recipe.totalTimeDisplay && (
              <span className="inline-flex items-center gap-1 whitespace-nowrap">
                <Clock className="size-3.5" aria-hidden="true" />
                {recipe.totalTimeDisplay}
              </span>
            )}
            {recipe.category && <span className="whitespace-nowrap">{recipe.category}</span>}
            {recipe.addedByHandle && <span className="whitespace-nowrap">saved by {recipe.addedByHandle}</span>}
          </MetaRow>
        </div>

        {/* Which household collections this recipe is filed in, and the way onto
          another one (collections plan §7). Reads the same cached collections
          query the tree and the ledger do — memberships are a client-side join,
          not a second request. */}
        <CollectionChips householdId={householdId} recipeId={recipe.recipeId} recipeTitle={recipe.title} recipeUnpublished={recipe.unpublished} />

        {/* Action row */}
        <div className="flex flex-wrap items-center gap-2">
          {/* `cook_mode_opened`'s `source` names where the apron was tapped in a
            vocabulary that predates `analyticsSurface` — the recipe page's
            button is `"button"`, the planner's card is `"plan_card"`. Keep the
            recipe page's historical value so its event is unchanged; every
            other surface names itself. */}
          <CookModeLauncher
            recipe={recipe}
            autoOpen={autoOpenCook}
            analyticsSource={analyticsSurface === "recipe_detail" ? "button" : analyticsSurface}
            onAutoOpenConsumed={onCookModeClosed}
            onOpened={onResultAction ? () => onResultAction("cook") : undefined}
          />
          {/* Offline, every control on this row disables rather than queuing.
            M1 ships offline READS; the writes here are the ones §5.2 shows are
            not replay-safe by shape — a server-side favourite toggle flips twice
            on a double delivery, and the shared note is the field two people
            erase each other on. Saying "not now" is honest; silently queuing a
            write that would corrupt on replay is not. */}
          <Button
            variant="outline"
            aria-pressed={recipe.favorite}
            disabled={favoriteMutation.isPending || !online}
            title={online ? undefined : OFFLINE_WRITE_HINT}
            onClick={onFavorite}
            className={cn(recipe.favorite && "bg-primary text-primary-foreground hover:bg-primary")}
          >
            <Star data-icon="inline-start" aria-hidden="true" className={cn(recipe.favorite && "fill-current")} />
            {recipe.favorite ? "Favorited" : "Favorite"}
          </Button>
          {/*
            The scale the pane is CURRENTLY showing rides along (plan D4): if you
            are reading this recipe at 2×, the list should get 2× of it. Nothing
            is written back to the recipe — `factor` is a reading preference and
            stays one.
          */}
          <Button
            variant="outline"
            disabled={!online}
            title={online ? undefined : OFFLINE_WRITE_HINT}
            onClick={() => {
              onResultAction?.("grocery");
              setListRequest({ recipes: [{ recipeId: recipe.recipeId, scale: factor }], label: recipe.title });
            }}
          >
            <ShoppingBasket data-icon="inline-start" aria-hidden="true" />
            Add to shopping list
          </Button>
          <Button
            variant="outline"
            disabled={!online}
            title={online ? undefined : OFFLINE_WRITE_HINT}
            onClick={() => {
              onResultAction?.("plan_dialog");
              setPlanRequest({ recipeId: recipe.recipeId, title: recipe.title });
            }}
          >
            <CalendarRange data-icon="inline-start" aria-hidden="true" />
            Add to meal planner
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto text-muted-foreground"
            disabled={!online || removeBlockedReason !== null}
            title={removeBlockedReason ?? (online ? undefined : OFFLINE_WRITE_HINT)}
            onClick={() => setConfirmRemove(true)}
          >
            <Trash2 data-icon="inline-start" aria-hidden="true" />
            Remove
          </Button>
        </div>

        {/* A disabled button fires no pointer events, so its `title` never
          becomes a tooltip — and on touch there is no hover to begin with. The
          reason has to be on the page. */}
        {removeBlockedReason && <p className="m-0 text-xs text-pretty text-muted-foreground">{removeBlockedReason}</p>}

        {/* Timers running for this recipe (global store, filtered) — plan §6.5 */}
        <RecipeTimerStrip recipeId={recipe.recipeId} className="empty:hidden" />

        {/* Body */}
        <div className="flex flex-wrap items-start gap-5">
          {/* Left column */}
          <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-3.5">
            <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg border-2 border-border bg-muted">
              {/*
                Absolutely filled so the image *covers* the 4/3 box (cropping to
                fit) instead of shrinking to its intrinsic size — a centering
                grid track collapses `size-full` to the image's natural width.

                `Img` covers both the no-photo case and the URL-that-404s case
                (a moved PDS, an evicted blob) with the same placeholder.
              */}
              <Img
                src={primaryImage?.url}
                alt={primaryImage?.alt ?? ""}
                className="absolute inset-0 size-full object-cover"
                fallback={
                  <div className="grid size-full place-content-center">
                    <UtensilsCrossed className="size-10 text-muted-foreground" aria-hidden="true" />
                  </div>
                }
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <h2 className="display-title m-0 text-base text-foreground">Ingredients</h2>
              <button
                type="button"
                aria-expanded={scaleOpen}
                aria-controls="recipe-scale-panel"
                onClick={() => setScaleOpen((v) => !v)}
                className={cn(
                  "inline-flex h-[22px] items-center gap-1 rounded-md px-1.5 text-[0.6875rem] font-bold transition-colors hover:bg-accent",
                  scaleActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Settings2 className="size-3" aria-hidden="true" />
                {scaleLabel}
              </button>
            </div>

            {scaleOpen && (
              <ScalePanel
                id="recipe-scale-panel"
                factor={factor}
                metric={metric}
                onFactor={setFactor}
                onMetric={setMetric}
                onReset={() => {
                  setFactor(1);
                  setMetric(false);
                }}
              />
            )}

            {scaledIngredients.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {scaledIngredients.map((line, i) => (
                  <li key={i} className="flex gap-2 text-[0.8125rem] leading-[1.35] text-foreground">
                    <span className="mt-[5px] size-[5px] shrink-0 rounded-full bg-primary" aria-hidden="true" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-[0.8125rem] text-muted-foreground">No ingredients listed.</p>
            )}

            <NutritionStrip nutrition={recipe.nutrition} servings={displayServings} />

            <RecipeTagStrip author={{ cuisine: recipe.cuisine, category: recipe.category, diets: recipe.suitableForDiet ?? [] }} labels={recipe.enrichment} />
          </div>

          {/* Right column */}
          <div className="flex min-w-0 flex-[1.35_1_320px] flex-col gap-3.5">
            <div className="flex flex-col gap-2">
              <h2 className="display-title m-0 text-base text-foreground">Method</h2>
              {recipe.instructions.length > 0 ? (
                <ol className="m-0 flex list-none flex-col gap-2 p-0">
                  {recipe.instructions.map((step, i) => (
                    <li key={i} className="flex gap-2.5 text-[0.875rem] leading-[1.45] text-balance text-foreground">
                      <span className="grid size-5 shrink-0 place-content-center rounded-full border-2 border-border bg-primary text-[0.6875rem] font-bold text-primary-foreground">
                        {i + 1}
                      </span>
                      <span>
                        <StepText text={step} recipeId={recipe.recipeId} recipeTitle={recipe.title} variant="detail" />
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="m-0 text-[0.875rem] text-muted-foreground">No method steps listed.</p>
              )}
            </div>

            <NoteEditor recipeId={recipe.recipeId} initialBody={recipe.note?.body ?? ""} online={online} />
          </div>
        </div>
      </div>

      {/* Collections plan §2.5 applies to recipes too: a publish dialog has to
        name the account the record lands in and the handle every later update
        will come from, because both are the acting member's and neither is
        visible from the button. */}
      <ConfirmDialog
        open={confirmPublish}
        onOpenChange={setConfirmPublish}
        title="Publish this recipe?"
        description={
          <>
            This writes the recipe to your own atproto account{myHandle ? `, ${myHandle}` : ""} — a portable record on your PDS that any app on the network can read. Every future
            update to it goes out from {myHandle ?? "your account"} too, whichever member of your household makes the edit. It’s hard to undo.
          </>
        }
        confirmLabel="Publish"
        pending={publishing}
        onConfirm={onPublish}
      />

      <ConfirmDialog
        open={needsReauth}
        onOpenChange={setNeedsReauth}
        title="Buttery needs new permissions"
        description="Publishing writes this recipe to your own atproto account, and that permission was added after you last signed in. Reconnect to grant it — you'll come back here and can publish again. The recipe stays private until then."
        confirmLabel="Reconnect account"
        cancelLabel="Not now"
        pending={reauthPending}
        onConfirm={onReconnect}
      />

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove from the box?"
        description={
          plannedAhead ? (
            <>
              This removes the recipe from your household's shelf and deletes its shared note. The recipe stays in the public collection.{" "}
              <strong className="font-semibold text-foreground">This recipe is on your meal plan{nextPlannedLabel ? ` (next: ${nextPlannedLabel})` : ""}.</strong> Your meal plan
              will keep working — the recipe stays viewable and linked. Remove it from your box anyway?
            </>
          ) : (
            "This removes the recipe from your household's shelf and deletes its shared note. The recipe stays in the public collection."
          )
        }
        confirmLabel="Remove"
        destructive
        pending={removing}
        onConfirm={onRemove}
      />

      <AddToPlanDialog request={planRequest} onClose={() => setPlanRequest(null)} onAdded={onPlanned} />

      {/* The rows land on `/household/list`, which is a cached query now rather
        than a loader — so the toast is not the whole feedback loop any more.
        Without this invalidation the shopping list would still be showing its
        pre-add payload for the next 10s (`groceryListQuery`'s `staleTime`) with
        nothing queued to correct it, which is the one screen where a missing
        row means buying the thing twice. */}
      <AddPreviewDialog
        request={listRequest}
        onClose={() => setListRequest(null)}
        onCommitted={(result) => {
          setListRequest(null);
          posthog.capture("grocery_items_added", { recipe_id: recipe.recipeId, added: result.added, merged: result.merged, source: analyticsSurface });
          pushToast(summarizeGroceryAdd(result.added, result.merged));
          void queryClient.invalidateQueries({ queryKey: keys.household.grocery(householdId) });
        }}
        onError={(message) => pushToast(message)}
      />
    </div>
  );
}

/**
 * The shared private note. Debounced autosave (on idle + on blur); an empty body
 * clears the note. Household-visible, never published (the `eye-off` label is
 * literal — no atproto write path touches this).
 */
function NoteEditor({ recipeId, initialBody, online }: { recipeId: string; initialBody: string; online: boolean }) {
  const [body, setBody] = useState(initialBody);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef(initialBody);

  // No recipe-switch reset needed: DetailPane (and thus this editor) is keyed by
  // recipeId at the render site, so a new recipe remounts with fresh state.

  async function save(next: string) {
    if (next.trim() === lastSaved.current.trim()) return;
    setStatus("saving");
    try {
      await upsertHouseholdRecipeNote({ recipeId, body: next });
      lastSaved.current = next;
      setStatus("saved");
    } catch {
      setStatus("idle");
    }
  }

  function onChange(next: string) {
    setBody(next);
    setStatus("idle");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(next), 800);
  }

  function onBlur() {
    if (timer.current) clearTimeout(timer.current);
    void save(body);
  }

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const headingId = `note-heading-${recipeId}`;
  return (
    <div className="mt-1.5 flex flex-col gap-2 border-t-2 border-border/45 pt-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id={headingId} className="display-title m-0 text-base text-foreground">
          Notes
        </h2>
        <span className="inline-flex items-center gap-1 text-[0.6875rem] font-semibold text-muted-foreground">
          <EyeOff className="size-3" aria-hidden="true" />
          Never leaves this household
          {/* Autosave status is a status message: announced politely, not focus-stealing. */}
          <span role="status" aria-live="polite" className="ml-1 opacity-70">
            {status === "saving" ? "· Saving…" : status === "saved" ? "· Saved" : ""}
          </span>
        </span>
      </div>
      {/* Read-only offline rather than "type now, save later". The note is
        household-shared and last-write-wins, so a body typed on a phone in a
        store and replayed an hour later would silently overwrite whatever
        someone at home wrote in between. That conflict is what M3's OCC and
        two-pane panel exist for (§6.2); until then, not accepting the edit is
        the only answer that cannot lose someone's writing. */}
      <Textarea
        rows={4}
        aria-labelledby={headingId}
        value={body}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        readOnly={!online}
        title={online ? undefined : OFFLINE_WRITE_HINT}
        placeholder={online ? "What you'd change next time — the oven that runs hot, the swap that worked." : OFFLINE_WRITE_HINT}
        className="text-[0.8125rem]"
      />
    </div>
  );
}
