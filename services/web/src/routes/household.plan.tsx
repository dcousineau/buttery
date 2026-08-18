import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { BookOpenText, CalendarCheck, CalendarRange, Check, ChevronLeft, ChevronRight, Copy, PanelLeft } from "lucide-react";
import * as z from "zod";
import { useAnalytics } from "#/lib/analytics";
import {
  addMealPlanRecipesMutation,
  addRecipeToHousehold,
  copyMealPlanWeek,
  getHouseholdRecipe,
  type HouseholdRecipeDetail,
  type HouseholdRecipeRow,
  keys,
  mealPlanWeekQuery,
  moveMealPlanEntryMutation,
  removeMealPlanEntryMutation,
  saveMealPlanNoteMutation,
  setMealPlanEntryCookedMutation,
} from "#/lib/api";
import { ensureActiveHousehold } from "#/lib/offline/active-household";
import { OfflineRouteError } from "#/components/offline/OfflineRouteError";
import { OFFLINE_WRITE_HINT, useIsOnline } from "#/lib/offline/use-online";
import { type MealSlot, type PlanDate, isPlanDate, shiftWeeks, weekStartFor } from "#/lib/plan/week";
import { formatPlanDate, weekRangeLabel } from "#/lib/plan/labels";
import { PlanWeekGrid } from "#/components/plan/PlanWeekGrid";
import { PlanDaysAgenda } from "#/components/plan/PlanDaysAgenda";
import { PlanActionsProvider, type PlanActionsValue } from "#/components/plan/PlanActions";
import { AddEntryDialog, type AddEntryRequest } from "#/components/plan/AddEntryDialog";
import { MoveEntryDialog, type MoveEntryRequest } from "#/components/plan/MoveEntryDialog";
import { CopyWeekDialog } from "#/components/plan/CopyWeekDialog";
import { ThisWeekPanel } from "#/components/plan/ThisWeekPanel";
import { AddPreviewDialog, type AddPreviewRequest } from "#/components/grocery/AddPreviewDialog";
import { summarizeGroceryAdd } from "#/components/grocery/added-summary";
import { CookModeFallback, CookModeOverlay } from "#/components/recipes/CookModeOverlay";
import { findEntry, optimisticNoteEntry, optimisticRecipeEntry } from "#/components/plan/optimistic";
import { Button } from "#/components/ui/button";
import { Toast, ToastViewport, useToasts } from "#/components/ui/toast";
import { useIsMobile } from "#/lib/hooks/use-mobile";
import { cn } from "#/lib/utils";
import { seo } from "#/lib/seo";

/**
 * The meal planner (`/household/plan?week=YYYY-MM-DD&view=week|days&panel=1`).
 *
 * Three pieces of state, all in the URL (D15) so a week is shareable and the
 * back button does what it looks like it does:
 *
 * - `week` is a **loader dep** — changing it refetches.
 * - `view` and `panel` are pure client state that happen to live in the URL, so
 *   they are deliberately NOT in `loaderDeps`: toggling either re-renders from
 *   the cached payload and never hits the server (acceptance #18).
 *
 * Every param is `.catch()`-guarded: a hand-mangled `?week=banana` falls back to
 * the current week rather than throwing a route error at someone who only
 * mistyped a URL. The server recomputes the week start from the household's
 * timezone and week-start preference regardless of what arrives.
 *
 * The route also owns every write (§8): the optimistic patch over the cached
 * week, the toast, the live-region announcement, and the invalidation that
 * reconciles the two — the plan *prefix*, never one week's key, because
 * `"current"` and a dated week are two entries over the same seven days
 * (`keys.household.planAll`). Nothing below it awaits a mutation — see
 * `components/plan/PlanActions.tsx`.
 */

const searchSchema = z.object({
  /** A Monday-or-whatever week start; the server snaps it to the household's week-start day. */
  week: z.string().refine(isPlanDate).optional().catch(undefined),
  view: z.enum(["week", "days"]).optional().catch(undefined),
  panel: z
    .union([z.boolean(), z.literal("1"), z.literal("true")])
    .transform((value) => value === true || value === "1" || value === "true")
    .optional()
    .catch(undefined),
});

export const Route = createFileRoute("/household/plan")({
  validateSearch: searchSchema,
  // ONLY `week`. Adding `view`/`panel` here would make a layout toggle refetch
  // the whole week for no new data — and now that the week is a query key, it
  // would also mint a cache entry per layout toggle.
  loaderDeps: ({ search }) => ({ week: search.week }),
  beforeLoad: async () => ({ ...(await ensureActiveHousehold()) }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(mealPlanWeekQuery(context.householdId, deps.week)),
  head: () => ({ meta: seo({ title: "Meal plan · Buttery", description: "What your household is eating this week." }) }),
  // An offline-capable route renders what has been cached; when the answer is
  // "nothing yet", that is a state, not a crash (§4.4).
  errorComponent: OfflineRouteError,
  component: PlanPage,
});

function PlanPage() {
  const { householdId } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const online = useIsOnline();
  const { toasts, push, dismiss, pauseAll, resumeAll } = useToasts(4000);
  const { posthog } = useAnalytics();

  /**
   * The week, from the query cache.
   *
   * This replaces a `useOptimistic` overlay laid over the loader's payload, and
   * with it four pieces of machinery that only existed to bridge two caches: the
   * transition-scoped patch, the `whenLoaderCommits` promise, the ref that
   * resolved it on the commit carrying a new payload, and the 1s escape hatch for
   * a write that produced no new payload at all. All of it was there because
   * `router.invalidate()` resolves *before* React commits the router's matches,
   * so there was a window in which the optimistic week had been dropped and the
   * settled one had not yet arrived — one frame of pre-write data on every write.
   *
   * Query has no such window: `onMutate` writes the patch into the cache entry
   * itself, so the "optimistic" and "settled" values are the same value at
   * different times, and the rollback in `onError` is a write to that same entry.
   * See `src/lib/api/mutations.ts`.
   *
   * The `focus`/`visibilitychange` listener D10 asked for is gone from this file
   * too: `refetchOnWindowFocus` is on by default on the QueryClient, and
   * `staleTime` is the throttle the hand-rolled version needed a timestamp for.
   */
  const { data: week } = useSuspenseQuery(mealPlanWeekQuery(householdId, search.week));
  const [announcement, setAnnouncement] = useState("");
  const [addRequest, setAddRequest] = useState<AddEntryRequest | null>(null);
  const [moveRequest, setMoveRequest] = useState<MoveEntryRequest | null>(null);
  const [copyRequest, setCopyRequest] = useState<PlanDate | null>(null);
  const [listRequest, setListRequest] = useState<AddPreviewRequest | null>(null);
  const [scrollNonce, setScrollNonce] = useState(0);
  /**
   * Cook mode over the planner (§7.5). Two states, because the recipe body is
   * not in the week payload — the plan carries titles, not steps — so the apron
   * cannot open until a fetch lands: `cookPending` holds the full-screen spinner
   * up while it does, `cookRecipe` is the apron itself. `cookRequest` is the
   * same id in a ref, so a response can be matched against the launch that is
   * current *now* rather than the one that was current when it was sent.
   */
  const [cookPending, setCookPending] = useState<string | null>(null);
  const [cookRecipe, setCookRecipe] = useState<HouseholdRecipeDetail | null>(null);
  const cookRequest = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverSlot, setDragOverSlot] = useState<string | null>(null);

  /**
   * Every write on the week, as Query mutations, all bound to this week's key.
   * The optimistic patch functions are the same pure ones as before
   * (`components/plan/optimistic.ts`, still unit-tested); what changed is who
   * applies them.
   */
  const move = useMutation(moveMealPlanEntryMutation(queryClient, householdId, search.week));
  const removeEntryMutation = useMutation(removeMealPlanEntryMutation(queryClient, householdId, search.week));
  const setCookedMutation = useMutation(setMealPlanEntryCookedMutation(queryClient, householdId, search.week));
  const addRecipes = useMutation(addMealPlanRecipesMutation(queryClient, householdId, search.week));
  const saveNote = useMutation(saveMealPlanNoteMutation(queryClient, householdId, search.week));

  /** The one failure message every write on this page shares. */
  function onWriteFailed(error: unknown) {
    push({ variant: "destructive", title: error instanceof Error ? error.message : "That didn’t save. Try again." });
  }

  /**
   * Re-read the plan. Used by the writes that have no honest optimistic patch.
   *
   * The whole plan prefix, not `plan(householdId, search.week)`. One week can
   * sit in the cache under two keys — `"current"` when the URL carries no
   * `?week=`, and its date when it does — because only the server can map
   * "this week" onto a week start (household timezone, week-start day). A write
   * made under `?week=X` that invalidated only that key leaves the `"current"`
   * entry holding pre-write data, so: Next week, Previous week (which writes an
   * explicit `?week=`), delete a meal, Today — and the deleted meal is back on
   * screen for the rest of `staleTime`. `keys.household.planAll` carries the
   * long version. The preferences save below already reached for this prefix
   * for its own reason (a week-start change re-buckets every week); it turns
   * out to be the right blast radius for every plan write, not just that one.
   */
  async function refreshPlan() {
    await queryClient.invalidateQueries({ queryKey: keys.household.planAll(householdId) });
  }

  /** The label a toast or announcement uses for an entry. */
  function entryLabel(entryId: string): string {
    const found = findEntry(week, entryId);
    if (!found) return "Entry";
    return found.entry.kind === "note" ? "Note" : found.entry.title;
  }

  /**
   * The one write that is NOT optimistic (§6.7): a copy lands on a week that is
   * usually not the one on screen, and the count in its toast is the server's
   * answer, not something the client can guess. So it just runs, reports, and
   * invalidates — the grid updates only if the destination happens to be visible.
   *
   * An empty source is reported as news, not as a failure: `copied: 0` is the
   * server saying there was nothing there, which is a plain toast, not a red one.
   */
  function copyWeek(fromWeek: PlanDate, toWeek: PlanDate, mode: "append" | "replace") {
    void (async () => {
      try {
        const result = await copyMealPlanWeek({ fromWeek, toWeek, mode });
        if (result.copied === 0) {
          push({ variant: "default", title: "That week is empty — nothing to copy" });
          return;
        }
        push({
          variant: "success",
          title: `${result.copied} ${result.copied === 1 ? "entry" : "entries"} copied to ${weekRangeLabel(result.toWeek, result.toWeekEnd)}`,
        });
        setAnnouncement("Week copied");
      } catch (error) {
        onWriteFailed(error);
      } finally {
        // Both weeks are in the plan prefix, so the destination is covered
        // whether or not it happens to be the one on screen — the entries that
        // are not being observed are simply marked stale and re-read when
        // someone navigates to them.
        await refreshPlan();
      }
    })();
  }

  function submitRecipes(date: PlanDate, slot: MealSlot, rows: HouseholdRecipeRow[]) {
    setAnnouncement(`${rows.length} added to ${slot} on ${formatPlanDate(date)}`);
    addRecipes.mutate(
      { date, slot, recipeIds: rows.map((row) => row.recipeId), optimisticEntries: rows.map(optimisticRecipeEntry) },
      {
        onSuccess: () => push({ variant: "success", title: rows.length === 1 ? `${rows[0].title} added` : `${rows.length} recipes added` }),
        onError: onWriteFailed,
      },
    );
  }

  function submitNote(request: AddEntryRequest, body: string) {
    if (request.kind === "edit-note") {
      saveNote.mutate(
        { entryId: request.entryId, date: request.date, slot: request.slot, body },
        {
          onSuccess: () => push({ variant: "success", title: body.trim() === "" ? "Note removed" : "Note saved" }),
          onError: onWriteFailed,
        },
      );
      return;
    }
    setAnnouncement(`Note added to ${request.slot} on ${formatPlanDate(request.date)}`);
    saveNote.mutate(
      { date: request.date, slot: request.slot, body, optimisticEntry: optimisticNoteEntry(body, 0) },
      { onSuccess: () => push({ variant: "success", title: "Note added" }), onError: onWriteFailed },
    );
  }

  /**
   * The apron opens over the week rather than at `/household/recipes/{id}?cook`
   * (which is what the shortcut used to link to). Cook mode is a fullscreen
   * modal, and a modal returns you to where you opened it — landing on a recipe
   * page after exiting is a navigation nobody asked for.
   */
  function startCook(recipeId: string) {
    posthog.capture("cook_mode_opened", { recipe_id: recipeId, source: "plan_card" });
    // The guard is a ref, not the pending state: two quick taps on different
    // cards would otherwise open whichever request happened to finish last,
    // rather than the one asked for most recently.
    cookRequest.current = recipeId;
    setCookPending(recipeId);

    function settle(handle: () => void) {
      if (cookRequest.current !== recipeId) return;
      cookRequest.current = null;
      setCookPending(null);
      handle();
    }

    getHouseholdRecipe(recipeId)
      .then((recipe) => {
        settle(() => {
          if (recipe) setCookRecipe(recipe);
          else push({ variant: "destructive", title: "That recipe isn’t in your box anymore." });
        });
      })
      .catch(() => {
        settle(() => push({ variant: "destructive", title: "Couldn’t open cook mode. Try again." }));
      });
  }

  const actions: PlanActionsValue = {
    startCook,
    openAdd: (date, slot) => {
      const day = week.days.find((candidate) => candidate.date === date);
      setAddRequest({ kind: "add", date, slot, existingCount: day?.slots[slot].length ?? 0, isToday: day?.isToday ?? false });
    },
    openNoteEditor: (entryId) => {
      const found = findEntry(week, entryId);
      if (!found || found.entry.kind !== "note") return;
      setAddRequest({ kind: "edit-note", date: found.date, slot: found.slot, entryId, body: found.entry.body });
    },
    openMove: (entryId) => {
      const found = findEntry(week, entryId);
      if (!found) return;
      setMoveRequest({ entryId, fromDate: found.date, fromSlot: found.slot });
    },
    moveEntry: (entryId, toDate, toSlot) => {
      const found = findEntry(week, entryId);
      // A drop onto the slot the card is already in is not a move — announcing
      // one would be a lie, and the server no-ops it anyway.
      if (!found || (found.date === toDate && found.slot === toSlot)) return;
      const label = entryLabel(entryId);
      setAnnouncement(`${label} moved to ${toSlot} on ${formatPlanDate(toDate)}`);
      move.mutate({ entryId, toDate, toSlot }, { onSuccess: () => push({ variant: "success", title: `Moved to ${toSlot} · ${formatPlanDate(toDate)}` }), onError: onWriteFailed });
    },
    removeEntry: (entryId) => {
      const label = entryLabel(entryId);
      setAnnouncement("Entry removed");
      removeEntryMutation.mutate({ entryId }, { onSuccess: () => push({ variant: "success", title: `${label} removed` }), onError: onWriteFailed });
    },
    setCooked: (entryId, cooked) => {
      setCookedMutation.mutate(
        { entryId, cooked },
        { onSuccess: () => push({ variant: "success", title: cooked ? "Marked cooked" : "Cooked mark cleared" }), onError: onWriteFailed },
      );
    },
    addBackToBox: (entryId) => {
      const found = findEntry(week, entryId);
      if (!found || found.entry.kind !== "recipe") return;
      const { recipeId } = found.entry;
      // No optimistic patch and no mutation factory: `inBox` is the *box's*
      // answer, not the plan's, so there is nothing honest to paint on the week —
      // both keys are simply re-read once the server has taken it.
      void (async () => {
        try {
          await addRecipeToHousehold(recipeId);
          push({ variant: "success", title: "Added back to your box" });
          await Promise.all([refreshPlan(), queryClient.invalidateQueries({ queryKey: keys.household.recipes(householdId) })]);
        } catch (error) {
          onWriteFailed(error);
        }
      })();
    },
    /** M1 writes are online-only (§4.1); the cards disable their own controls. */
    writable: online,
    draggingId,
    setDraggingId,
    dragOverSlot,
    setDragOverSlot,
  };

  // D16: below `md` the week grid cannot be made readable, so the days agenda is
  // the only layout and the toggle is absent rather than disabled. The URL is
  // left alone — rotating a tablet back to landscape restores the chosen view.
  const view = isMobile ? "days" : (search.view ?? "week");
  const panelOpen = search.panel === true;
  const isEmpty = week.emptySlotCount === 28;
  const isNextWeek = week.weekStart === shiftWeeks(weekStartFor(week.today, week.weekStartDay), 1);

  function goToWeek(next: string | undefined) {
    void navigate({ search: (prev) => ({ ...prev, week: next }), replace: true });
  }

  function setView(next: "week" | "days") {
    void navigate({ search: (prev) => ({ ...prev, view: next }), replace: true });
  }

  // The panel is URL state (D15) but not history-worthy on its own: `replace`
  // keeps the back button pointed at the last week you looked at, not at the
  // last time you opened a panel. `undefined` drops the param rather than
  // writing `?panel=false`.
  function setPanel(next: boolean) {
    void navigate({ search: (prev) => ({ ...prev, panel: next ? true : undefined }), replace: true });
  }

  return (
    <PlanActionsProvider value={actions}>
      <div className="flex h-[calc(100svh-var(--header-height,4rem))] min-h-0 w-full">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Below `md` every control has to fit one line on a 390px phone, so
            the title steps down, the week label loses its 9rem reservation, and
            the panel toggle is icon-only (see below). It still wraps rather than
            overflows if a locale's week label runs long. */}
          <div className="flex flex-none flex-wrap items-center gap-x-2 gap-y-2 border-b-2 border-border bg-card px-3 py-2.5 md:gap-x-2.5 md:px-4">
            <h1 className="display-title m-0 text-base leading-[1.1] md:text-[1.625rem]">Meal plan</h1>

            <div role="group" aria-label="Layout" className="hidden overflow-hidden rounded-lg border-2 border-border shadow-pop-sm md:flex">
              <button
                type="button"
                aria-pressed={view === "week"}
                onClick={() => setView("week")}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 px-2.5 text-xs font-semibold focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  view === "week" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <CalendarRange className="size-[13px]" aria-hidden="true" />
                Week
              </button>
              <button
                type="button"
                aria-pressed={view === "days"}
                onClick={() => setView("days")}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 border-l-2 border-l-border px-2.5 text-xs font-semibold focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  view === "days" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <BookOpenText className="size-[13px]" aria-hidden="true" />
                Days
              </button>
            </div>

            <div className="flex min-w-0 items-center gap-1 md:gap-1.5">
              <Button variant="outline" size="icon-sm" aria-label="Previous week" onClick={() => goToWeek(shiftWeeks(week.weekStart, -1))}>
                <ChevronLeft aria-hidden="true" />
              </Button>
              <span className="px-0.5 text-center text-xs font-bold whitespace-nowrap md:min-w-[9rem] md:text-sm">{weekRangeLabel(week.weekStart, week.weekEnd)}</span>
              <Button variant="outline" size="icon-sm" aria-label="Next week" onClick={() => goToWeek(shiftWeeks(week.weekStart, 1))}>
                <ChevronRight aria-hidden="true" />
              </Button>
              {/* Dropping `week` entirely rather than pinning today's date keeps the
                URL clean and lets the server decide what "today" means in the
                household's timezone. The nonce is what makes "Today" do
                something when the current week is already on screen: the URL
                does not change, so only a bumped nonce re-runs the agenda's
                scroll-to-today. */}
              {/* Outline, not ghost: it sits between two outlined chevrons and a
                flat label there reads as static text, not a control. The icon
                is desktop-only and takes `md:pl-2` rather than
                `data-icon="inline-start"` — that attribute tightens the left
                padding through a `:has()` rule that outranks any `max-md:`
                override, which would leave the mobile label off-centre. */}
              <Button
                variant="outline"
                size="sm"
                className="max-md:h-7 max-md:px-1.5 max-md:text-xs md:pl-2"
                onClick={() => {
                  goToWeek(undefined);
                  setScrollNonce((nonce) => nonce + 1);
                }}
              >
                <CalendarCheck className="max-md:hidden" aria-hidden="true" />
                Today
              </Button>
            </div>

            <div className="ml-auto flex items-center gap-2">
              {!panelOpen && (
                // Icon-only below `md`: the label is what pushes this row onto a
                // second line on a phone, and the `aria-label` (which the rail
                // button already carries) keeps the name identical either way.
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Show this week panel"
                  aria-expanded={false}
                  onClick={() => setPanel(true)}
                  className="max-md:size-7 max-md:px-0 md:pl-2"
                >
                  <PanelLeft aria-hidden="true" />
                  <span className="max-md:hidden">This week</span>
                </Button>
              )}
            </div>
          </div>

          {/* Announces the results of planner actions (added, moved, removed).
            Toasts carry the same news visually, but they are `aria-live` on a
            viewport that is also used for failures — this stays the one place a
            screen reader hears what changed in the grid. */}
          <p aria-live="polite" className="sr-only">
            {announcement}
          </p>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 pt-3.5 pb-6">
            {/* Scoped to next week, the one week where planning is the obvious
              next move: a past week being empty is history, not a prompt, and
              offering to fill a week three out invites planning further ahead
              than anyone actually eats. */}
            {isEmpty && isNextWeek && (
              <div className="flex flex-none flex-wrap items-center gap-2.5 rounded-lg border-2 border-border bg-secondary px-3 py-2.5 text-secondary-foreground shadow-pop-sm">
                <CalendarRange className="size-[18px] shrink-0" aria-hidden="true" />
                <p className="m-0 text-[0.8125rem] font-semibold">Nothing planned this week yet. Fill a slot below, or bring last week over and edit it.</p>
                {/* Straight to the copy, no dialog: the week is empty, so
                  "append or replace?" has one possible answer. */}
                <Button
                  size="sm"
                  className="ml-auto"
                  disabled={!online}
                  title={online ? undefined : OFFLINE_WRITE_HINT}
                  onClick={() => copyWeek(shiftWeeks(week.weekStart, -1), week.weekStart, "append")}
                >
                  <Copy data-icon="inline-start" aria-hidden="true" />
                  Copy last week in
                </Button>
              </div>
            )}

            {view === "week" ? <PlanWeekGrid week={week} /> : <PlanDaysAgenda week={week} scrollNonce={scrollNonce} />}
          </div>
        </section>

        <ThisWeekPanel
          week={week}
          open={panelOpen}
          onOpenChange={setPanel}
          writable={online}
          onCopyWeek={() => setCopyRequest(week.weekStart)}
          onAddWeekToList={() => setListRequest({ planWeek: week.weekStart, label: "this week’s plan" })}
          onNotify={(title) => push({ variant: "success", title })}
          onPreferencesSaved={(title) => {
            push({ variant: "success", title });
            // A week-start or timezone change re-buckets the grid and moves
            // "today", so the week has to be read again — the panel never
            // patches it itself. Every week is affected, not just this one,
            // which is what the plan prefix covers.
            void refreshPlan();
          }}
          onError={(title) => push({ variant: "destructive", title })}
        />
      </div>

      <CopyWeekDialog weekStart={copyRequest} onClose={() => setCopyRequest(null)} onCopy={copyWeek} />

      {/*
        The rows land on `/household/list`, and the toast is no longer the whole
        feedback loop over there. While that route was a plain loader, walking to
        it re-read it; now that it reads `groceryListQuery` (§4.1), an
        un-invalidated key means the list still shows its pre-add payload for the
        next 10s (that factory's `staleTime`) with nothing queued to correct it —
        on the one screen where a missing row means buying the thing twice. The
        toast still names where the rows went, so the button never reads as a
        no-op; it is just not the only thing that happens.
      */}
      <AddPreviewDialog
        request={listRequest}
        onClose={() => setListRequest(null)}
        onCommitted={(result) => {
          setListRequest(null);
          push({ variant: "success", title: summarizeGroceryAdd(result.added, result.merged) });
          void queryClient.invalidateQueries({ queryKey: keys.household.grocery(householdId) });
        }}
        onError={(title) => push({ variant: "destructive", title })}
      />

      <AddEntryDialog
        request={addRequest}
        onClose={() => setAddRequest(null)}
        onSubmitRecipes={(rows) => {
          if (addRequest) submitRecipes(addRequest.date, addRequest.slot, rows);
        }}
        onSubmitNote={(body) => {
          if (addRequest) submitNote(addRequest, body);
        }}
      />
      <MoveEntryDialog request={moveRequest} dates={week.days.map((day) => day.date)} onClose={() => setMoveRequest(null)} onMove={actions.moveEntry} />

      {/* The fallback stands in for the whole apron while the recipe body is in
        flight, so the tap has a full-screen response immediately — the same
        screen the lazy chunk shows, so the fetch and the chunk load read as one
        wait rather than two. */}
      {cookPending && <CookModeFallback />}
      {cookRecipe && <CookModeOverlay recipe={cookRecipe} onClose={() => setCookRecipe(null)} />}

      <ToastViewport position="bottom-center" onMouseEnter={pauseAll} onMouseLeave={resumeAll} onFocusCapture={pauseAll} onBlurCapture={resumeAll}>
        {toasts.map((toast) => (
          <Toast key={toast.id} variant={toast.variant} title={toast.title} onClose={() => dismiss(toast.id)}>
            {toast.variant === "success" && <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
          </Toast>
        ))}
      </ToastViewport>
    </PlanActionsProvider>
  );
}
