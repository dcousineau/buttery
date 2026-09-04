import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dices, X } from "lucide-react";
import { householdCollectionsQuery, randomizerPoolQuery, type RandomizerCard, type RandomizerPool } from "#/lib/api";
import { useAnalytics } from "#/lib/analytics";
import { ensureActiveHousehold } from "#/lib/offline/active-household";
import { OfflineRouteError } from "#/components/offline/OfflineRouteError";
import { RecipesViewProvider } from "#/components/recipes/RecipesViewProvider";
import { clearFilters, countSheetFilters, defaultFilters, draw, hasActiveFilters, isResultStale, toPoolFilters, type RandomizerFilterState } from "#/lib/randomizer/draw";
import { useReducedMotion } from "#/components/randomizer/use-reduced-motion";
import { usePersistedRandomizerFilters } from "#/components/randomizer/use-persisted-randomizer-filters";
import { RandomizerFilterBar } from "#/components/randomizer/RandomizerFilterBar";
import { RandomizerFiltersSheet } from "#/components/randomizer/RandomizerFiltersSheet";
import { RandomizerEmptyState } from "#/components/randomizer/RandomizerEmptyState";
import { RandomizerBoxResult } from "#/components/randomizer/RandomizerBoxResult";
import { RandomizerCorpusResult } from "#/components/randomizer/RandomizerCorpusResult";
import { RandomizerPlanShortcut } from "#/components/randomizer/RandomizerPlanShortcut";
import { Button } from "#/components/ui/button";
import { Pane, PaneBody, PaneHeader, PaneScroller } from "#/components/ui/pane";
import { seo } from "#/lib/seo";

/**
 * "What should I make?" — the meal randomizer
 * (`docs/plans/2026-08-30-meal-randomizer.md`, §6 all, §7 all, §8, §9, §12).
 *
 * `/household/randomizer`, full-width main pane, no ledger and no collections
 * column — its own place in the sidebar, a peer of Recipes and the planner
 * (§6.1, §12: the comp wins over the spec's original "nested under
 * /household/recipes").
 *
 * Filter state lives in COMPONENT STATE, not the URL — deliberately not a
 * `loaderDep`/search param like the planner's `week`. §5.5/§6.3 describe a
 * filter set that resets to non-trivial defaults on "Clear filters" and is
 * never expected to be shared or bookmarked (unlike a plan week); the comp
 * keeps it local too. A page reload starts over at the defaults, same as the
 * comp.
 */

export const Route = createFileRoute("/household/randomizer")({
  beforeLoad: async () => ({ ...(await ensureActiveHousehold()) }),
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(randomizerPoolQuery(context.householdId, toPoolFilters(defaultFilters()))),
      // Primed so the "More filters" sheet's Collection select has no
      // first-open flash — small, and already offline-capable (§4.1 of the
      // offline plan) so this costs nothing extra when it's already warm from
      // /household/recipes.
      context.queryClient.ensureQueryData(householdCollectionsQuery(context.householdId)),
    ]),
  head: () => ({ meta: seo({ title: "Randomizer · Buttery", description: "Can't decide? Roll the dice, dinner picks itself." }) }),
  errorComponent: OfflineRouteError,
  component: RandomizerPage,
});

/** The pre-fetch fallback for the filter bar / sheet's facet options. */
const EMPTY_FACETS = { cuisines: [], mealTypes: [], diets: [], allergens: [], spiceLevels: [] };

/** §5.6's stale marker, verbatim. One string, rendered twice — once as paint, once as an announcement. */
const STALE_RESULT_MESSAGE = "Doesn't match your current filters";

/**
 * One drawn card, plus which scope it came from (§4.5) — the scope decides
 * whether `RandomizerBoxResult` or `RandomizerCorpusResult` renders it.
 *
 * Deliberately carries NO `onlyMatch` flag from the draw itself: "is this the
 * only match" is a property of the CURRENT pool, not a fact frozen at roll
 * time — a pool of 1 that grows back to 196 after "Clear filters" must stop
 * disabling "Roll again", and only reading it live off `pool.pool.length`
 * (below, where `onlyMatchBlocked` is computed) gets that right. Storing it
 * on the draw result was tried first and caught in browser verification: it
 * left the button stuck on "That's the only match" after the pool grew back.
 */
interface DrawnResult {
  card: RandomizerCard;
  source: "box" | "corpus";
}

/** §9: "Send filter KEYS, never free-text values." Every field except `source`, same set `hasActiveFilters` treats as a filter. */
function activeFilterKeys(f: RandomizerFilterState): string[] {
  const d = defaultFilters();
  const active: string[] = [];
  if (f.collectionIds.length > 0) active.push("collectionIds");
  if (f.favoritesOnly !== d.favoritesOnly) active.push("favoritesOnly");
  if (f.cuisine !== d.cuisine) active.push("cuisine");
  if (f.maxCookMinutes !== d.maxCookMinutes) active.push("maxCookMinutes");
  if (f.includeUntimed !== d.includeUntimed) active.push("includeUntimed");
  if (f.ingredient !== d.ingredient) active.push("ingredient");
  if (f.mealType !== d.mealType) active.push("mealType");
  if (f.diets.length > 0) active.push("diets");
  if (f.avoidAllergens.length > 0) active.push("avoidAllergens");
  if (f.spiceLevel !== d.spiceLevel) active.push("spiceLevel");
  if (f.skipRecentDays !== d.skipRecentDays) active.push("skipRecentDays");
  return active;
}

/**
 * §4/§6.2's pool line — the always-visible count, never a coverage report (§4.3).
 *
 * `skipRecentDays` is passed in rather than the phrase being written out,
 * because the window has to be spelled ONE way on this screen. §6.2 quotes the
 * line as "skipping 6 from the last 2 weeks" and the comp's chip says
 * "Skipping the last 14 days" — both had a source, and the screen shipped
 * saying both about the same number, with "2 weeks" as a literal that would
 * have gone on claiming a fortnight after the constant moved. The chip's unit
 * won (days is what the API stores and what {@link SKIP_RECENT_DAYS} holds);
 * the spec's sentence shape is kept.
 */
function poolLineText(pool: RandomizerPool | undefined, skipRecentDays: number | null): string {
  if (!pool) return "Rolling from your recipes…";
  const n = pool.pool.length;
  const parts: string[] = [];
  if (pool.source === "box") {
    parts.push(`Rolling from ${n} ${n === 1 ? "recipe" : "recipes"}`);
  } else {
    parts.push(`Rolling from ${n} public ${n === 1 ? "recipe" : "recipes"} you haven't kept`);
  }
  if (skipRecentDays !== null && pool.skippedRecent > 0) {
    parts.push(`skipping ${pool.skippedRecent} from the last ${skipRecentDays} days`);
  }
  if (pool.capped) {
    parts.push(`capped at ${pool.cap} matches — narrow the filters to see the rest`);
  }
  return parts.join(" · ");
}

function RandomizerPage() {
  const { householdId } = Route.useRouteContext();
  const { posthog } = useAnalytics();
  const reducedMotion = useReducedMotion();

  const queryClient = useQueryClient();
  // Change 2: filters persist to `localStorage` per household — see the
  // hook's own doc comment for the SSR/hydration handling and why the
  // write-back can't fire before the restore has. `source` is deliberately
  // never restored (widening to the public corpus is opt-in every visit,
  // never sticky); the hook's `restoreFilters` call always comes back
  // `source: "box"`.
  const [filters, setFilters] = usePersistedRandomizerFilters(householdId);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [drawn, setDrawn] = useState<DrawnResult | null>(null);
  const [rolling, setRolling] = useState(false);
  const [widening, setWidening] = useState(false);
  const rollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rollIndex = useRef(0);
  const lastCapturedPool = useRef<RandomizerPool | null>(null);
  // The telemetry effect below must fire once per SETTLED pool object, not
  // re-run just because `filters` state changes — so it reads `filters`
  // through a ref kept in sync by its own effect rather than listing
  // `filters` itself as a dependency.
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const poolFilters = useMemo(() => toPoolFilters(filters), [filters]);
  const poolQuery = useQuery({
    ...randomizerPoolQuery(householdId, poolFilters),
    // §5.6: a filter change must not flash the pool line or blank the result
    // while the new pool is in flight — the previous pool stays visible
    // (`isFetching` still flips true/false for callers that need to know).
    placeholderData: keepPreviousData,
  });
  const collectionsQuery = useQuery(householdCollectionsQuery(householdId));

  const pool = poolQuery.data;

  useEffect(
    () => () => {
      if (rollTimer.current) clearTimeout(rollTimer.current);
    },
    [],
  );

  // §9 randomizer_pool_fetched / randomizer_empty_pool — fired once per
  // SETTLED pool (the object reference only changes when a fetch resolves;
  // `keepPreviousData` means it does NOT change on every render while
  // fetching), so a filter change fires this once, not once per refetch tick.
  useEffect(() => {
    if (!pool || pool === lastCapturedPool.current) return;
    lastCapturedPool.current = pool;
    const filterKeys = activeFilterKeys(filtersRef.current);
    posthog.capture("randomizer_pool_fetched", { filter_keys: filterKeys, pool_size: pool.pool.length, unenriched_in_scope: pool.unenrichedInScope, source: pool.source });
    if (pool.pool.length === 0) {
      posthog.capture("randomizer_empty_pool", { filter_keys: filterKeys, source: pool.source });
    }
  }, [pool, posthog]);

  /** §5.1/§5.2/§5.3: one draw, from `candidates`, gated behind the §5.6 tumble unless `prefers-reduced-motion`. */
  const performRoll = useCallback(
    (candidates: RandomizerCard[], excludeRecipeId: string | null, source: "box" | "corpus") => {
      // Nothing to draw is not "clear the screen" (§5.6): whatever is already
      // rendered stays, `isResultStale` marks it, and the empty state renders
      // in the controls region above it. Only widening can reach this — "Roll
      // again" is disabled at pool size 0 — and a widen that finds nothing must
      // not blank the recipe the reader was in the middle of.
      const result = draw(candidates, excludeRecipeId);
      if (result.status === "empty") return;
      const { card } = result;
      rollIndex.current += 1;
      posthog.capture("randomizer_rolled", {
        roll_index: rollIndex.current,
        no_repeat_fired: excludeRecipeId !== null && card.recipeId !== excludeRecipeId,
        source,
      });

      function commit() {
        setDrawn({ card, source });
        setRolling(false);
      }

      if (reducedMotion) {
        commit();
        return;
      }
      setRolling(true);
      if (rollTimer.current) clearTimeout(rollTimer.current);
      rollTimer.current = setTimeout(commit, 700);
    },
    [reducedMotion, posthog],
  );

  function onRoll() {
    if (!pool) return;
    performRoll(pool.pool, drawn?.card.recipeId ?? null, pool.source);
  }

  function onChangeFilters(patch: Partial<RandomizerFilterState>) {
    setFilters((f) => ({ ...f, ...patch }));
  }

  function onClearFilters() {
    // §5.5: resets every filter to the non-empty defaults. Per §5.6, clearing
    // filters does NOT clear a drawn recipe — `drawn` is untouched here.
    setFilters((f) => clearFilters(f));
  }

  /**
   * §4.5/§12: "widening rolls immediately" — the user asked a question by
   * widening, so answer it rather than making them press the button again.
   *
   * `queryClient.fetchQuery` (not `setFilters` + an effect watching for the
   * pool to settle) both fetches AND populates the exact cache entry
   * `randomizerPoolQuery(householdId, corpusFilters)` builds, so flipping
   * `filters.source` to `"corpus"` right after finds that same entry already
   * warm — no visible second fetch, no separate "waiting for the corpus pool"
   * effect needed at all.
   */
  async function onWidenToCorpus() {
    posthog.capture("randomizer_widened_to_corpus", { filter_keys: activeFilterKeys(filters) });
    setWidening(true);
    try {
      const corpusFilters = toPoolFilters({ ...filters, source: "corpus" });
      const corpusPool = await queryClient.fetchQuery(randomizerPoolQuery(householdId, corpusFilters));
      setFilters((f) => ({ ...f, source: "corpus" }));
      performRoll(corpusPool.pool, drawn?.card.recipeId ?? null, "corpus");
    } finally {
      setWidening(false);
    }
  }

  /**
   * §9's `randomizer_result_action`. Three of its five values happen inside
   * `DetailPane`'s own handlers, which reach back out through the optional
   * `onResultAction` prop §7.2 sanctions — the pane keeps sending its own
   * `meal_plan_entry_added` / `grocery_items_added` / `cook_mode_opened`
   * events unchanged; this is the surface-level "did anyone act on what we
   * suggested?" counter beside them.
   *
   * `plan_today` is captured by `RandomizerPlanShortcut`, the one action this
   * surface owns. `open_recipe` is NOT captured, because there is nothing to
   * capture: on this surface the drawn recipe IS the full recipe view, and
   * §7.2 forbids adding an action the design does not have just to make an
   * event fire. Recorded in the results doc rather than faked here.
   */
  function captureResultAction(action: "plan_dialog" | "grocery" | "cook") {
    posthog.capture("randomizer_result_action", { action, source: drawn?.source ?? "box", recipe_id: drawn?.card.recipeId ?? null });
  }

  function onDismissWiden() {
    setFilters((f) => ({ ...f, source: "box" }));
  }

  // A recipe kept from the corpus (RandomizerCorpusResult's "Add to your
  // box") flips this SAME drawn card over to the box renderer — no re-roll,
  // the box's own actions just appear (§4.5).
  function onKeptFromCorpus() {
    setDrawn((d) => (d ? { ...d, source: "box" } : d));
  }

  const stale = drawn ? isResultStale(drawn.card.recipeId, pool?.pool ?? []) : false;
  const settledEmpty = !poolQuery.isFetching && pool !== undefined && pool.pool.length === 0;
  // Read live off the CURRENT pool, not a flag frozen at draw time (see the
  // `DrawnResult` doc) — a pool of 1 that grows back after "Clear filters"
  // must stop disabling "Roll again".
  const onlyMatchBlocked = drawn !== null && !stale && pool !== undefined && pool.pool.length === 1;
  const rollDisabled = rolling || onlyMatchBlocked || (pool !== undefined && pool.pool.length === 0);
  const rollLabel = rolling ? "Rolling…" : onlyMatchBlocked ? "That's the only match" : drawn ? "Roll again" : "What should I make?";

  return (
    <RecipesViewProvider householdId={householdId}>
      <Pane className="flex-col">
        <PaneScroller>
          {/* Controls — the head of the pane (§6.2), and the one head on this
            surface, so it collapses: on a phone it is most of the screen, and
            the recipe under it is what you came to read. It scrolls away with
            the result and is back the moment you return to the top. */}
          <PaneHeader collapseOnScroll className="flex flex-col gap-3 px-4 py-3.5">
            <h1 className="display-title m-0 text-[1.375rem] leading-[1.1] text-foreground">What should I make?</h1>

            {/* Announced politely — the pool count and the roll outcome are the
            two things worth a screen reader hearing without stealing focus. */}
            <p aria-live="polite" className="m-0 text-[0.8125rem] font-semibold text-muted-foreground">
              {poolLineText(pool, filters.skipRecentDays)}
            </p>

            <RandomizerFilterBar
              filters={filters}
              facets={pool?.facets ?? EMPTY_FACETS}
              hasActiveFilters={hasActiveFilters(filters)}
              sheetFilterCount={countSheetFilters(filters)}
              onChange={onChangeFilters}
              onOpenSheet={() => setSheetOpen(true)}
              onClear={onClearFilters}
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={onRoll} disabled={rollDisabled}>
                <Dices data-icon="inline-start" aria-hidden="true" className={rolling ? "animate-spin" : undefined} />
                {rollLabel}
              </Button>

              {drawn && !stale && drawn.source === "box" && <RandomizerPlanShortcut householdId={householdId} recipeId={drawn.card.recipeId} />}

              {filters.source === "corpus" && (
                <Button variant="secondary" size="sm" onClick={onDismissWiden}>
                  Public recipes
                  <X data-icon="inline-end" aria-hidden="true" />
                </Button>
              )}

              {/* §5.6's whole point is that the result below stops matching
              WITHOUT moving — so the one person who cannot see it stop matching
              is the one who most needs telling. The visible marker is paint
              (`aria-hidden`); the announcement comes from a live region that is
              always mounted and empty until `stale` flips, because a live
              region that appears at the same moment as its text is not
              reliably announced. It is a sibling of the pool line's region, not
              part of it, so a filter change never runs the two together. */}
              <span role="status" className="sr-only">
                {stale ? STALE_RESULT_MESSAGE : ""}
              </span>
              {stale && (
                <span aria-hidden="true" className="text-[0.8125rem] font-semibold text-warning">
                  {STALE_RESULT_MESSAGE}
                </span>
              )}
            </div>

            {/* §5.6: a filter change that empties the pool renders THIS in the
            controls region, next to the (still-visible, now-stale) result
            below — never clearing it. Before any roll, the equivalent empty
            state renders in the result region instead (below). */}
            {settledEmpty && drawn && (
              <RandomizerEmptyState
                source={pool.source}
                totalInScope={pool.totalInScope}
                unenrichedInScope={pool.unenrichedInScope}
                widening={widening}
                onClear={onClearFilters}
                onWiden={onWidenToCorpus}
              />
            )}
          </PaneHeader>

          {/* Result — scrolls up past the controls, readable measure, centred (§6.2). */}
          <PaneBody>
            {rolling ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
                <Dices className="size-10 animate-spin" aria-hidden="true" />
                <p className="m-0 text-sm font-semibold">Rolling…</p>
              </div>
            ) : drawn ? (
              drawn.source === "box" ? (
                <RandomizerBoxResult householdId={householdId} card={drawn.card} onResultAction={captureResultAction} />
              ) : (
                <RandomizerCorpusResult householdId={householdId} card={drawn.card} onKept={onKeptFromCorpus} />
              )
            ) : settledEmpty && pool ? (
              <div className="mx-auto max-w-[54rem] px-5 pt-6">
                <RandomizerEmptyState
                  source={pool.source}
                  totalInScope={pool.totalInScope}
                  unenrichedInScope={pool.unenrichedInScope}
                  widening={widening}
                  onClear={onClearFilters}
                  onWiden={onWidenToCorpus}
                />
              </div>
            ) : (
              <div className="mx-auto flex max-w-[54rem] flex-col items-start gap-1.5 px-5 pt-8">
                <h2 className="display-title m-0 text-lg text-foreground">Nothing drawn yet</h2>
                <p className="m-0 text-sm text-muted-foreground">Set a filter or two if you like, then roll. Can't decide? Roll the dice, dinner picks itself.</p>
              </div>
            )}
          </PaneBody>
        </PaneScroller>
      </Pane>

      <RandomizerFiltersSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        filters={filters}
        facets={pool?.facets ?? EMPTY_FACETS}
        collections={collectionsQuery.data}
        onChange={onChangeFilters}
      />
    </RecipesViewProvider>
  );
}
