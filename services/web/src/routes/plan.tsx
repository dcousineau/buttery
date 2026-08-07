import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { BookOpenText, CalendarCheck, CalendarRange, Check, ChevronLeft, ChevronRight, Copy, PanelLeft } from "lucide-react";
import * as z from "zod";
import {
  addMealPlanNote,
  addMealPlanRecipes,
  copyMealPlanWeek,
  getMealPlanWeek,
  moveMealPlanEntry,
  removeMealPlanEntry,
  setMealPlanEntryCooked,
  updateMealPlanNote,
  type PlanWeek,
} from "#/server/meal-plan";
import { addRecipeToHousehold, type HouseholdRecipeRow } from "#/server/household-recipes";
import { requireActiveHousehold } from "#/server/household/onboarding";
import { type MealSlot, type PlanDate, isPlanDate, shiftWeeks, weekStartFor } from "#/lib/plan/week";
import { formatPlanDate, weekRangeLabel } from "#/lib/plan/labels";
import { PlanWeekGrid } from "#/components/plan/PlanWeekGrid";
import { PlanDaysAgenda } from "#/components/plan/PlanDaysAgenda";
import { PlanActionsProvider, type PlanActionsValue } from "#/components/plan/PlanActions";
import { AddEntryDialog, type AddEntryRequest } from "#/components/plan/AddEntryDialog";
import { MoveEntryDialog, type MoveEntryRequest } from "#/components/plan/MoveEntryDialog";
import { CopyWeekDialog } from "#/components/plan/CopyWeekDialog";
import { ThisWeekPanel } from "#/components/plan/ThisWeekPanel";
import {
  findEntry,
  optimisticNoteEntry,
  optimisticRecipeEntry,
  withEntriesAppended,
  withEntryCooked,
  withEntryMoved,
  withEntryRemoved,
  withNoteBody,
} from "#/components/plan/optimistic";
import { Button } from "#/components/ui/button";
import { Toast, ToastViewport, useToasts } from "#/components/ui/toast";
import { useIsMobile } from "#/lib/hooks/use-mobile";
import { cn } from "#/lib/utils";
import { seo } from "#/lib/seo";

/**
 * The meal planner (`/plan?week=YYYY-MM-DD&view=week|days&panel=1`).
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
 * The route also owns every write (§8): the optimistic patch over the loader's
 * week, the toast, the live-region announcement, and the `router.invalidate()`
 * that reconciles the two. Nothing below it awaits a mutation — see
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

export const Route = createFileRoute("/plan")({
  validateSearch: searchSchema,
  // ONLY `week`. Adding `view`/`panel` here would make a layout toggle refetch
  // the whole week for no new data.
  loaderDeps: ({ search }) => ({ week: search.week }),
  loader: async ({ deps }) => {
    await requireActiveHousehold();
    return await getMealPlanWeek({ data: { week: deps.week } });
  },
  head: () => ({ meta: seo({ title: "Meal plan · Buttery", description: "What your household is eating this week." }) }),
  component: PlanPage,
});

function PlanPage() {
  const loaded = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const isMobile = useIsMobile();
  const { toasts, push, dismiss, pauseAll, resumeAll } = useToasts(4000);

  // The optimistic overlay (§8.2). Held only between a mutation firing and its
  // `router.invalidate()` landing; the week-start check discards a patch that
  // belongs to a week the user has already navigated away from.
  const [patched, setPatched] = useState<PlanWeek | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [addRequest, setAddRequest] = useState<AddEntryRequest | null>(null);
  const [moveRequest, setMoveRequest] = useState<MoveEntryRequest | null>(null);
  const [copyRequest, setCopyRequest] = useState<PlanDate | null>(null);
  const [scrollNonce, setScrollNonce] = useState(0);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverSlot, setDragOverSlot] = useState<string | null>(null);
  const week = patched && patched.weekStart === loaded.weekStart ? patched : loaded;

  /**
   * D10's answer to "two people planning at once": no sockets, just look again
   * when you come back. Coming back to the tab is the moment a stale week is
   * most likely and least expensive to fix. Throttled so alt-tabbing does not
   * hammer the loader.
   */
  useEffect(() => {
    let last = 0;
    function refresh() {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last < 10_000) return;
      last = now;
      void router.invalidate();
    }
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);

  /**
   * One shape for every write: paint, send, then reconcile.
   *
   * Failure does not try to un-apply the patch — it drops it. The loader is the
   * only thing that knows what the week really contains, and after a failed
   * write it is also the only thing that knows whether the write half-happened.
   * The `finally` invalidate runs on both paths for the same reason.
   */
  const run = useCallback(
    async (options: { optimistic?: (week: PlanWeek) => PlanWeek; action: () => Promise<unknown>; toast?: string; announce?: string }) => {
      const { optimistic } = options;
      if (optimistic) setPatched((prev) => optimistic(prev && prev.weekStart === loaded.weekStart ? prev : loaded));
      try {
        await options.action();
        if (options.toast) push({ variant: "success", title: options.toast });
        if (options.announce) setAnnouncement(options.announce);
      } catch (error) {
        push({ variant: "destructive", title: error instanceof Error ? error.message : "That didn’t save. Try again." });
      } finally {
        await router.invalidate();
        setPatched(null);
      }
    },
    [loaded, push, router],
  );

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
        const result = await copyMealPlanWeek({ data: { fromWeek, toWeek, mode } });
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
        push({ variant: "destructive", title: error instanceof Error ? error.message : "That didn’t save. Try again." });
      } finally {
        await router.invalidate();
      }
    })();
  }

  function submitRecipes(date: PlanDate, slot: MealSlot, rows: HouseholdRecipeRow[]) {
    void run({
      optimistic: (current) => withEntriesAppended(current, date, slot, rows.map(optimisticRecipeEntry)),
      action: () => addMealPlanRecipes({ data: { date, slot, recipeIds: rows.map((row) => row.recipeId) } }),
      toast: rows.length === 1 ? `${rows[0].title} added` : `${rows.length} recipes added`,
      announce: `${rows.length} added to ${slot} on ${formatPlanDate(date)}`,
    });
  }

  function submitNote(request: AddEntryRequest, body: string) {
    if (request.kind === "edit-note") {
      void run({
        optimistic: (current) => withNoteBody(current, request.entryId, body),
        action: () => updateMealPlanNote({ data: { entryId: request.entryId, body } }),
        toast: body.trim() === "" ? "Note removed" : "Note saved",
      });
      return;
    }
    void run({
      optimistic: (current) => withEntriesAppended(current, request.date, request.slot, [optimisticNoteEntry(body, 0)]),
      action: () => addMealPlanNote({ data: { date: request.date, slot: request.slot, body } }),
      toast: "Note added",
      announce: `Note added to ${request.slot} on ${formatPlanDate(request.date)}`,
    });
  }

  const actions: PlanActionsValue = {
    openAdd(date, slot) {
      const day = week.days.find((candidate) => candidate.date === date);
      setAddRequest({ kind: "add", date, slot, existingCount: day?.slots[slot].length ?? 0, isToday: day?.isToday ?? false });
    },
    openNoteEditor(entryId) {
      const found = findEntry(week, entryId);
      if (!found || found.entry.kind !== "note") return;
      setAddRequest({ kind: "edit-note", date: found.date, slot: found.slot, entryId, body: found.entry.body });
    },
    openMove(entryId) {
      const found = findEntry(week, entryId);
      if (!found) return;
      setMoveRequest({ entryId, fromDate: found.date, fromSlot: found.slot });
    },
    moveEntry(entryId, toDate, toSlot) {
      const found = findEntry(week, entryId);
      // A drop onto the slot the card is already in is not a move — announcing
      // one would be a lie, and the server no-ops it anyway.
      if (!found || (found.date === toDate && found.slot === toSlot)) return;
      const label = entryLabel(entryId);
      void run({
        optimistic: (current) => withEntryMoved(current, entryId, toDate, toSlot),
        action: () => moveMealPlanEntry({ data: { entryId, toDate, toSlot } }),
        toast: `Moved to ${toSlot} · ${formatPlanDate(toDate)}`,
        announce: `${label} moved to ${toSlot} on ${formatPlanDate(toDate)}`,
      });
    },
    removeEntry(entryId) {
      const label = entryLabel(entryId);
      void run({
        optimistic: (current) => withEntryRemoved(current, entryId),
        action: () => removeMealPlanEntry({ data: { entryId } }),
        toast: `${label} removed`,
        announce: "Entry removed",
      });
    },
    setCooked(entryId, cooked) {
      void run({
        optimistic: (current) => withEntryCooked(current, entryId, cooked),
        action: () => setMealPlanEntryCooked({ data: { entryId, cooked } }),
        toast: cooked ? "Marked cooked" : "Cooked mark cleared",
      });
    },
    addBackToBox(entryId) {
      const found = findEntry(week, entryId);
      if (!found || found.entry.kind !== "recipe") return;
      const { recipeId } = found.entry;
      // No optimistic patch: `inBox` is the box's answer, not the plan's, and
      // the invalidate is what re-reads it.
      void run({ action: () => addRecipeToHousehold({ data: { recipeId } }), toast: "Added back to your box" });
    },
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
                <Button size="sm" className="ml-auto" onClick={() => copyWeek(shiftWeeks(week.weekStart, -1), week.weekStart, "append")}>
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
          onCopyWeek={() => setCopyRequest(week.weekStart)}
          onNotify={(title) => push({ variant: "success", title })}
          onPreferencesSaved={(title) => {
            push({ variant: "success", title });
            // A week-start or timezone change re-buckets the grid and moves
            // "today", so the loader has to run again — the panel never patches
            // the week itself.
            void router.invalidate();
          }}
          onError={(title) => push({ variant: "destructive", title })}
        />
      </div>

      <CopyWeekDialog weekStart={copyRequest} onClose={() => setCopyRequest(null)} onCopy={copyWeek} />

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
