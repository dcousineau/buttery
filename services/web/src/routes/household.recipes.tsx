import { useState } from "react";
import { Check } from "lucide-react";
import { createFileRoute, Outlet, useParams, useRouter, useRouterState } from "@tanstack/react-router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { householdRecipesQuery, keys } from "#/lib/api";
import { ensureActiveHousehold } from "#/lib/offline/active-household";
import { OfflineRouteError } from "#/components/offline/OfflineRouteError";
import { useRecipeMirror } from "#/lib/offline/use-recipe-mirror";
import { Toast, ToastViewport, useToasts } from "#/components/ui/toast";
import { RecipeLedger, type LedgerFilters } from "#/components/recipes/RecipeLedger";
import { GlobalRecipePicker } from "#/components/recipes/GlobalRecipePicker";
import { AddRecipeChooser } from "#/components/recipes/create/AddRecipeChooser";
import { RecipesViewContext } from "#/components/recipes/context";
import { RecipeScaleContext } from "#/components/recipes/scale";
import { cn } from "#/lib/utils";
import { seo } from "#/lib/seo";

/**
 * The recipes master–detail shell (plan §5.1). A layout route: the ledger (left)
 * stays mounted while the detail (`$id` child) or the empty-state (`index` child)
 * renders in the right pane via <Outlet/> — so selecting a recipe keeps the
 * ledger's scroll/place and never re-fetches it. The loader gates through
 * `requireActiveHousehold` (the stale-active guard) exactly like `/household`, then
 * primes the box query.
 *
 * **Offline-capable (offline plan §4.1).** The box comes from
 * `householdRecipesQuery`, so it is persisted to IndexedDB, refetched on
 * reconnect, and — via `useRecipeMirror` — the work queue the mini-mirror walks
 * to make every *detail* readable offline too (§4.6). The loader primes the same
 * cache entry the component then observes, which is what keeps SSR streaming.
 *
 * `requireActiveHousehold` is still awaited rather than folded into a query: it
 * is a redirect, not data — its whole job is to throw before anything renders
 * when the active household went stale.
 */
export const Route = createFileRoute("/household/recipes")({
  // The stale-active guard, and the cache partition, in one step. `beforeLoad`
  // rather than `loader` because its result is *context* — the `$id` child needs
  // the household id to build its own query key, and a loader's return value is
  // not visible to a child route.
  beforeLoad: async () => ({ ...(await ensureActiveHousehold()) }),
  loader: ({ context }) => context.queryClient.ensureQueryData(householdRecipesQuery(context.householdId)),
  head: () => ({ meta: seo({ title: "Recipes · Buttery", description: "Your household's recipe box." }) }),
  // An offline-capable route renders what has been cached; when the answer is
  // "nothing yet", that is a state, not a crash (§4.4).
  errorComponent: OfflineRouteError,
  component: RecipesLayout,
});

function RecipesLayout() {
  const { householdId } = Route.useRouteContext();
  // The hook, not the loader's return value: an unobserved query gets no
  // refetch-on-reconnect, no invalidation and no gc protection — which is
  // precisely the machinery offline depends on (§4.1).
  const { data: recipes } = useSuspenseQuery(householdRecipesQuery(householdId));
  // Walks the box in idle time so an unvisited recipe still opens in a store.
  useRecipeMirror(householdId, recipes);
  const queryClient = useQueryClient();
  const router = useRouter();
  // On a child ($id) route, params.id is the selected recipe; on the index it is
  // undefined. `strict: false` lets this read the child param from the layout.
  const params = useParams({ strict: false });
  const selectedId = (params as { id?: string }).id ?? null;
  const hasSelection = selectedId != null;

  // The full-page create form (`/household/recipes/new`) renders full width — the
  // ledger + picker are suppressed for it (plan §A5: the form is a full page).
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onNewForm = pathname.endsWith("/recipes/new");

  const [filters, setFilters] = useState<LedgerFilters>({ q: "", sort: "recent", mine: false });
  const [factor, setFactor] = useState(1);
  const [metric, setMetric] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  const { toasts, push, dismiss, pauseAll, resumeAll } = useToasts(4000);

  function pushToast(message: string) {
    push({ variant: "success", title: message });
  }

  async function onAdded(recipeId: string) {
    // Prefix-scoped, not `router.invalidate()`: the box gained a row, and
    // nothing else on screen did (§4.2). The whole-router invalidate this
    // replaces also re-ran every other loader in the tree.
    await queryClient.invalidateQueries({ queryKey: keys.household.recipes(householdId) });
    await router.navigate({ to: "/household/recipes/$id", params: { id: recipeId } });
    pushToast("Added to your box");
  }

  return (
    <RecipeScaleContext.Provider value={{ factor, setFactor, metric, setMetric }}>
      <RecipesViewContext.Provider value={{ openAddChooser: () => setChooserOpen(true), openPicker: () => setPickerOpen(true), pushToast }}>
        <div className="flex h-[calc(100svh-var(--header-height,4rem))] min-h-0 w-full">
          {!onNewForm && (
            <RecipeLedger
              recipes={recipes}
              selectedId={selectedId}
              filters={filters}
              onFiltersChange={setFilters}
              onAdd={() => setChooserOpen(true)}
              className={cn("w-full", hasSelection ? "hidden lg:flex" : "flex")}
            />
          )}
          <section className={cn("min-h-0 min-w-0 flex-1 flex-col bg-background", onNewForm || hasSelection ? "flex" : "hidden lg:flex")}>
            <Outlet />
          </section>
        </div>

        <AddRecipeChooser open={chooserOpen} onOpenChange={setChooserOpen} onAddExisting={() => setPickerOpen(true)} />
        <GlobalRecipePicker open={pickerOpen} onOpenChange={setPickerOpen} onAdded={onAdded} />

        <ToastViewport position="bottom-center" onMouseEnter={pauseAll} onMouseLeave={resumeAll} onFocusCapture={pauseAll} onBlurCapture={resumeAll}>
          {toasts.map((t) => (
            <Toast key={t.id} variant={t.variant} title={t.title} onClose={() => dismiss(t.id)}>
              <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            </Toast>
          ))}
        </ToastViewport>
      </RecipesViewContext.Provider>
    </RecipeScaleContext.Provider>
  );
}
