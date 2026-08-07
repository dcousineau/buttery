import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { usePostHog } from "@posthog/react";
import { ArrowLeft, CalendarRange, Clock, EyeOff, Lock, Settings2, ShoppingBasket, Star, Trash2, UtensilsCrossed } from "lucide-react";
import type { HouseholdRecipeDetail } from "#/server/household-recipes";
import { removeRecipeFromHousehold, toggleHouseholdRecipeFavorite, upsertHouseholdRecipeNote } from "#/server/household-recipes";
import { publishRecipe } from "#/server/recipes-write";
import { Button } from "#/components/ui/button";
import { Textarea } from "#/components/ui/textarea";
import { ConfirmDialog } from "#/components/ConfirmDialog";
import { AddToPlanDialog, type AddToPlanRequest } from "#/components/plan/AddToPlanDialog";
import { SLOT_LABELS, formatPlanDate, shortDow } from "#/lib/plan/labels";
import type { MealSlot, PlanDate } from "#/lib/plan/week";
import { scaleIngredients } from "#/lib/recipe-scale";
import { cn } from "#/lib/utils";
import { authClient } from "#/lib/auth-client";
import { reconnectAtproto } from "#/lib/atproto-reauth";
import { useRecipesView } from "./context";
import { useRecipeScale } from "./scale";
import { SourceIcon } from "./SourceIcon";
import { ScalePanel } from "./ScalePanel";
import { NutritionStrip } from "./NutritionStrip";
import { UnavailableBanner } from "./UnavailableBanner";
import { StepText } from "./StepText";
import { CookModeLauncher } from "./CookModeLauncher";
import { RecipeTimerStrip } from "#/components/timers/RecipeTimerStrip";

/**
 * The recipe detail pane (right column; full screen on mobile). Reads the shared
 * scale/units prefs and the picker/toast handles from the recipes shell. Favorite
 * and the shared note are server-persisted (optimistic UI); the scale/units
 * settings are ephemeral reading prefs. Apron / shopping / planner are stubbed
 * (toast, no persistence) — seams for projects 04/05/06 (plan §7).
 */
export function DetailPane({
  recipe,
  autoOpenCook = false,
  onCookModeClosed,
}: {
  recipe: HouseholdRecipeDetail;
  /** `?cook` — the external deep link straight into cook mode (meal planner §7.5). */
  autoOpenCook?: boolean;
  onCookModeClosed?: () => void;
}) {
  const router = useRouter();
  const posthog = usePostHog();
  const { pushToast } = useRecipesView();
  const { factor, setFactor, metric, setMetric } = useRecipeScale();
  const scrollRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Move focus to the recipe title when the pane mounts. The pane is keyed by
  // recipeId at the render site, so this fires on every selection — restoring
  // focus that would otherwise be lost to <body> (the tapped ledger row is
  // hidden on mobile). `preventScroll` keeps the pane pinned to the top.
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  const [favorite, setFavorite] = useState(recipe.favorite);
  const [favPending, setFavPending] = useState(false);
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
  // `handle` is an atproto-plugin column, absent from better-auth's base user type.
  const { data: session } = authClient.useSession() as { data: { user?: { handle?: string | null } } | null };

  // Detail-pane state (favorite, scroll position, note) is keyed by recipeId at
  // the render site (`<DetailPane key={recipe.recipeId} …/>`), so switching
  // recipes remounts this pane — favorite re-inits from props and scroll resets
  // naturally, with no setState-in-effect.

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

  async function onFavorite() {
    setFavorite((v) => !v);
    setFavPending(true);
    try {
      const { favorite } = await toggleHouseholdRecipeFavorite({ data: { recipeId: recipe.recipeId } });
      setFavorite(favorite);
      posthog.capture("recipe_favorite_toggled", { recipe_id: recipe.recipeId, favorited: favorite });
      await router.invalidate();
    } catch {
      setFavorite(recipe.favorite); // revert on failure
    } finally {
      setFavPending(false);
    }
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
      const res = await publishRecipe({ data: { recipeId: recipe.recipeId } });
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
      await router.invalidate();
    } finally {
      setPublishing(false);
      setConfirmPublish(false);
    }
  }

  async function onPlanned(date: PlanDate, slot: MealSlot) {
    posthog.capture("meal_plan_entry_added", { recipe_id: recipe.recipeId, slot, source: "recipe_detail" });
    pushToast(`Added to ${SLOT_LABELS[slot].toLowerCase()} on ${formatPlanDate(date)}`);
    // The pane's own "on your meal plan" line comes from the loader's
    // `plannedUsage`, so it is stale the moment this lands.
    await router.invalidate();
  }

  async function onRemove() {
    setRemoving(true);
    try {
      await removeRecipeFromHousehold({ data: { recipeId: recipe.recipeId } });
      posthog.capture("recipe_removed_from_household", { recipe_id: recipe.recipeId, planned_upcoming: planned?.upcoming ?? 0 });
      await router.navigate({ to: "/household/recipes" });
      await router.invalidate();
    } finally {
      setRemoving(false);
      setConfirmRemove(false);
    }
  }

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex max-w-[54rem] flex-col gap-3.5 px-5 pt-4 pb-8">
        {/* Mobile back affordance */}
        <Link to="/household/recipes" className="flex w-fit items-center gap-1 text-xs font-semibold text-muted-foreground no-underline hover:text-foreground lg:hidden">
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Back to the shelf
        </Link>

        {recipe.unavailable && <UnavailableBanner since={recipe.unavailableSince} />}

        {/* Title block */}
        <div className="flex flex-col gap-1.5">
          <h1 ref={titleRef} tabIndex={-1} className="display-title m-0 text-[1.625rem] leading-[1.1] text-balance text-foreground outline-none">
            {recipe.title}
          </h1>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.75rem] font-semibold text-muted-foreground">
            {recipe.unpublished && (
              <>
                <button
                  type="button"
                  onClick={() => setConfirmPublish(true)}
                  className="inline-flex items-center gap-1 rounded-4xl border-2 border-border bg-secondary px-2 py-0.5 text-secondary-foreground transition-colors hover:bg-accent"
                >
                  <Lock className="size-3" aria-hidden="true" />
                  Private · Publish
                </button>
                <span aria-hidden>·</span>
              </>
            )}
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <SourceIcon kind={recipe.source.kind} className="size-3.5" />
              {recipe.source.label}
            </span>
            {recipe.totalTimeDisplay && (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                  <Clock className="size-3.5" aria-hidden="true" />
                  {recipe.totalTimeDisplay}
                </span>
              </>
            )}
            {recipe.category && (
              <>
                <span aria-hidden>·</span>
                <span className="whitespace-nowrap">{recipe.category}</span>
              </>
            )}
            {recipe.addedByHandle && (
              <>
                <span aria-hidden>·</span>
                <span className="whitespace-nowrap">saved by {recipe.addedByHandle}</span>
              </>
            )}
          </div>
        </div>

        {/* Action row */}
        <div className="flex flex-wrap items-center gap-2">
          <CookModeLauncher recipe={recipe} autoOpen={autoOpenCook} onAutoOpenConsumed={onCookModeClosed} />
          <Button
            variant="outline"
            aria-pressed={favorite}
            disabled={favPending}
            onClick={onFavorite}
            className={cn(favorite && "bg-primary text-primary-foreground hover:bg-primary")}
          >
            <Star data-icon="inline-start" aria-hidden="true" className={cn(favorite && "fill-current")} />
            {favorite ? "Favorited" : "Favorite"}
          </Button>
          <Button variant="outline" onClick={() => pushToast("Added to the shopping list")}>
            <ShoppingBasket data-icon="inline-start" aria-hidden="true" />
            Add to shopping list
          </Button>
          <Button variant="outline" onClick={() => setPlanRequest({ recipeId: recipe.recipeId, title: recipe.title })}>
            <CalendarRange data-icon="inline-start" aria-hidden="true" />
            Add to meal planner
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={() => setConfirmRemove(true)}>
            <Trash2 data-icon="inline-start" aria-hidden="true" />
            Remove
          </Button>
        </div>

        {/* Timers running for this recipe (global store, filtered) — plan §6.5 */}
        <RecipeTimerStrip recipeId={recipe.recipeId} className="empty:hidden" />

        {/* Body */}
        <div className="flex flex-wrap items-start gap-5">
          {/* Left column */}
          <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-3.5">
            <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg border-2 border-border bg-muted">
              {primaryImage ? (
                // Absolutely filled so the image *covers* the 4/3 box (cropping to
                // fit) instead of shrinking to its intrinsic size — a centering
                // grid track collapses `size-full` to the image's natural width.
                <img src={primaryImage.url} alt={primaryImage.alt ?? ""} className="absolute inset-0 size-full object-cover" />
              ) : (
                <div className="grid size-full place-content-center">
                  <UtensilsCrossed className="size-10 text-muted-foreground" aria-hidden="true" />
                </div>
              )}
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

            <NoteEditor recipeId={recipe.recipeId} initialBody={recipe.note?.body ?? ""} />
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmPublish}
        onOpenChange={setConfirmPublish}
        title="Publish this recipe?"
        description="This makes the recipe public on atproto — a portable record in your repo that other apps can read. It's hard to undo."
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
    </div>
  );
}

/**
 * The shared private note. Debounced autosave (on idle + on blur); an empty body
 * clears the note. Household-visible, never published (the `eye-off` label is
 * literal — no atproto write path touches this).
 */
function NoteEditor({ recipeId, initialBody }: { recipeId: string; initialBody: string }) {
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
      await upsertHouseholdRecipeNote({ data: { recipeId, body: next } });
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
    timer.current = setTimeout(() => save(next), 800);
  }

  function onBlur() {
    if (timer.current) clearTimeout(timer.current);
    save(body);
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
      <Textarea
        rows={4}
        aria-labelledby={headingId}
        value={body}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder="What you'd change next time — the oven that runs hot, the swap that worked."
        className="text-[0.8125rem]"
      />
    </div>
  );
}
