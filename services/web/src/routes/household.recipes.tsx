import { useState } from "react";
import { Check } from "lucide-react";
import { createFileRoute, Outlet, useParams, useRouter } from "@tanstack/react-router";
import { requireActiveHousehold } from "#/server/household/onboarding";
import { listHouseholdRecipes } from "#/server/household-recipes";
import { Toast, ToastViewport, useToasts } from "#/components/ui/toast";
import { RecipeLedger, type LedgerFilters } from "#/components/recipes/RecipeLedger";
import { GlobalRecipePicker } from "#/components/recipes/GlobalRecipePicker";
import { RecipesViewContext } from "#/components/recipes/context";
import { cn } from "#/lib/utils";
import { seo } from "#/lib/seo";

/**
 * The recipes master–detail shell (plan §5.1). A layout route: the ledger (left)
 * stays mounted while the detail (`$id` child) or the empty-state (`index` child)
 * renders in the right pane via <Outlet/> — so selecting a recipe keeps the
 * ledger's scroll/place and never re-fetches it. The loader gates through
 * `requireActiveHousehold` (the stale-active guard) exactly like `/pantry`, then
 * loads the whole box.
 */
export const Route = createFileRoute("/household/recipes")({
  loader: async () => {
    const active = await requireActiveHousehold();
    const recipes = await listHouseholdRecipes();
    return { active, recipes };
  },
  head: () => ({ meta: seo({ title: "Recipes · Buttery", description: "Your household's recipe box." }) }),
  component: RecipesLayout,
});

function RecipesLayout() {
  const { recipes } = Route.useLoaderData();
  const router = useRouter();
  // On a child ($id) route, params.id is the selected recipe; on the index it is
  // undefined. `strict: false` lets this read the child param from the layout.
  const params = useParams({ strict: false });
  const selectedId = (params as { id?: string }).id ?? null;
  const hasSelection = selectedId != null;

  const [filters, setFilters] = useState<LedgerFilters>({ q: "", tag: "All", sort: "recent" });
  const [factor, setFactor] = useState(1);
  const [metric, setMetric] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { toasts, push, dismiss, pauseAll, resumeAll } = useToasts(4000);

  function pushToast(message: string) {
    push({ variant: "success", title: message });
  }

  async function onAdded(recipeId: string) {
    await router.invalidate();
    await router.navigate({ to: "/household/recipes/$id", params: { id: recipeId } });
    pushToast("Added to your box");
  }

  return (
    <RecipesViewContext.Provider value={{ factor, setFactor, metric, setMetric, openPicker: () => setPickerOpen(true), pushToast }}>
      <div className="flex h-[calc(100svh-var(--header-height,4rem))] min-h-0 w-full">
        <RecipeLedger
          recipes={recipes}
          selectedId={selectedId}
          filters={filters}
          onFiltersChange={setFilters}
          onOpenPicker={() => setPickerOpen(true)}
          className={cn("w-full", hasSelection ? "hidden lg:flex" : "flex")}
        />
        <section className={cn("min-h-0 min-w-0 flex-1 flex-col bg-background", hasSelection ? "flex" : "hidden lg:flex")}>
          <Outlet />
        </section>
      </div>

      <GlobalRecipePicker open={pickerOpen} onOpenChange={setPickerOpen} onAdded={onAdded} />

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
