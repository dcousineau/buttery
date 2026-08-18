import { useState } from "react";
import { Check } from "lucide-react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useHydratedSession } from "#/lib/auth-client";
import { requireActiveHousehold } from "#/lib/api";
import { getMealPlanWeek } from "#/lib/api";
import { addRecipeToHousehold, listHouseholdRecipes, searchGlobalRecipes, type GlobalRecipeResult } from "#/lib/api";
import { Badge } from "#/components/ui/badge";
import { Toast, ToastViewport, useToasts } from "#/components/ui/toast";
import { AddRecipeChooser } from "#/components/recipes/create/AddRecipeChooser";
import { GlobalRecipePicker } from "#/components/recipes/GlobalRecipePicker";
import { RecipesViewContext } from "#/components/recipes/context";
import { FillTheBoxCard } from "#/components/pantry/FillTheBoxCard";
import { FreshInYourBox } from "#/components/pantry/FreshInYourBox";
import { LockedFeaturesStrip } from "#/components/pantry/LockedFeaturesStrip";
import { NetworkRecipePreviewDialog } from "#/components/pantry/NetworkRecipePreviewDialog";
import { NotInYourBoxYet } from "#/components/pantry/NotInYourBoxYet";
import { ShoppingListTeaser } from "#/components/pantry/ShoppingListTeaser";
import { WeekAheadCard } from "#/components/pantry/WeekAheadCard";
import { seo } from "#/lib/seo";

/**
 * The logged-in landing (`/household`). This is where sign-in and the wordmark drop
 * an authenticated user with an active household — the sidebar-navved home of the
 * app, distinct from the public marketing page at `/`.
 *
 * The loader gates through {@link requireActiveHousehold}: an active-household
 * caller renders this overview; a multi-membership caller is redirected to the
 * picker (`/households/switch`), and a caller with no membership to onboarding.
 *
 * **Two states, both derived from data — never from a toggle.** A household with
 * an empty recipe box gets "Welcome to the pantry": one card that fills the box
 * and a strip of what is waiting on it. Everything else gets the overview — the
 * week ahead, what the household added lately, and public recipes not yet boxed.
 * The empty-plan panel inside the week card is likewise just what an empty week
 * looks like, not a separate mode.
 */
export const Route = createFileRoute("/household/")({
  loader: async () => {
    const active = await requireActiveHousehold();
    const recipes = await listHouseholdRecipes();

    // A fresh box means the overview has nothing to overview: the week card, the
    // network strip and their queries are all skipped rather than fetched and
    // thrown away. `recipes` is already ordered `added_at desc` by the server.
    if (recipes.length === 0) return { active, recipes, week: null, network: [] as GlobalRecipeResult[] };

    const [week, network] = await Promise.all([
      getMealPlanWeek(),
      // Best-effort garnish. The public corpus going quiet (or slow) must not
      // take the household's own pantry down with it.
      searchGlobalRecipes({ limit: NETWORK_COUNT }).then(
        (r) => r.results,
        () => [] as GlobalRecipeResult[],
      ),
    ]);

    return { active, recipes, week, network };
  },
  head: () => ({ meta: seo({ title: "Your pantry · Buttery", description: "Your household's home in Buttery." }) }),
  component: PantryPage,
});

/** Recipes in "Fresh in your box" — two full rows at the narrow end, one at the wide. */
const BOX_COUNT = 4;
/** Public recipes in "Not in your box yet". */
const NETWORK_COUNT = 3;

function PantryPage() {
  const { active, recipes, week, network } = Route.useLoaderData();
  const router = useRouter();
  const { data: session } = useHydratedSession();

  const [chooserOpen, setChooserOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [savingRecipeId, setSavingRecipeId] = useState<string | null>(null);
  // The network card being previewed, or null for "no preview open". The row
  // itself and not just its id: the dialog titles itself from the card's copy
  // while it fetches, and the row is already in hand at the click.
  const [previewRecipe, setPreviewRecipe] = useState<GlobalRecipeResult | null>(null);
  const { toasts, push, dismiss, pauseAll, resumeAll } = useToasts(4000);

  const isFresh = recipes.length === 0;
  // The handle the server stamps on `addedByHandle`, in the same "@" form, so the
  // comparison in `FreshInYourBox` is a string equality and not a parse.
  const handle = session?.user.handle ?? session?.user.name ?? null;
  const viewerHandle = handle ? `@${handle}` : null;

  function pushToast(message: string) {
    push({ variant: "success", title: message });
  }

  /**
   * Link a public recipe into the box, then re-read the loader so it moves
   * sections. Reports whether it landed: the card ignores the answer, but the
   * preview dialog closes itself on a success (the card behind it is on its way
   * out of "Not in your box yet") and stays open on a failure so the retry is
   * still one click away.
   */
  async function saveToBox(recipeId: string): Promise<boolean> {
    if (savingRecipeId) return false;
    setSavingRecipeId(recipeId);
    try {
      await addRecipeToHousehold(recipeId);
      await router.invalidate();
      pushToast("Added to your box");
      return true;
    } catch {
      push({ variant: "destructive", title: "That one didn't make it into the box. Try again." });
      return false;
    } finally {
      setSavingRecipeId(null);
    }
  }

  /** The picker's own add path — same destination, so it gets the same follow-through. */
  async function onPicked() {
    await router.invalidate();
    pushToast("Added to your box");
  }

  return (
    // `AddRecipeChooser` reads the recipes-shell context for its toast surface.
    // The pantry is not that shell, so it supplies the same three affordances
    // rather than forking the chooser into a props-only variant.
    <RecipesViewContext.Provider value={{ openAddChooser: () => setChooserOpen(true), openPicker: () => setPickerOpen(true), pushToast }}>
      <div className="page-wrap px-4 pt-10 pb-12 sm:pt-14">
        <div className="rise-in flex flex-col gap-8">
          <header className="flex flex-col items-start">
            <Badge variant="secondary" className="mb-3">
              {active.name}
            </Badge>
            <h1 className="display-title m-0 text-3xl leading-[1.1] text-foreground sm:text-4xl">{isFresh ? "Welcome to the pantry" : "Your pantry"}</h1>
            <p className="mt-3 mb-0 max-w-[34rem] text-sm text-muted-foreground text-pretty sm:text-base">
              {isFresh
                ? "The box is empty, which is the only real chore here. Bring the recipes you already cook and everything else — planning, shopping, cook mode — has something to work with."
                : "What's cooking this week, what the household added lately, and a few things from the network worth stealing."}
            </p>
          </header>

          {isFresh ? (
            <>
              <FillTheBoxCard onNotify={pushToast} />
              <LockedFeaturesStrip />
            </>
          ) : (
            <>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(18rem,1fr))] items-start gap-5">
                {week ? <WeekAheadCard week={week} /> : null}
                <ShoppingListTeaser />
              </div>

              <FreshInYourBox recipes={recipes.slice(0, BOX_COUNT)} viewerHandle={viewerHandle} onAddRecipe={() => setChooserOpen(true)} />

              {network.length > 0 ? (
                <NotInYourBoxYet recipes={network} onSave={saveToBox} onPreview={setPreviewRecipe} savingRecipeId={savingRecipeId} onSeeMore={() => setPickerOpen(true)} />
              ) : null}
            </>
          )}
        </div>
      </div>

      <NetworkRecipePreviewDialog
        recipe={previewRecipe}
        onOpenChange={(open) => {
          if (!open) setPreviewRecipe(null);
        }}
        onSave={saveToBox}
        saving={previewRecipe !== null && savingRecipeId === previewRecipe.recipeId}
      />

      <AddRecipeChooser open={chooserOpen} onOpenChange={setChooserOpen} onAddExisting={() => setPickerOpen(true)} />
      <GlobalRecipePicker open={pickerOpen} onOpenChange={setPickerOpen} onAdded={onPicked} />

      <ToastViewport position="bottom-center" onMouseEnter={pauseAll} onMouseLeave={resumeAll} onFocusCapture={pauseAll} onBlurCapture={resumeAll}>
        {toasts.map((t) => (
          <Toast key={t.id} variant={t.variant} title={t.title} onClose={() => dismiss(t.id)}>
            <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          </Toast>
        ))}
      </ToastViewport>
    </RecipesViewContext.Provider>
  );
}
