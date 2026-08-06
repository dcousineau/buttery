import { useMemo, useState, useSyncExternalStore } from "react";
import { CalendarRange, Copy, PanelLeft, ShoppingBasket, X } from "lucide-react";
import type { PlanWeek } from "#/server/meal-plan";
import { DEFAULT_HOUSEHOLD_PREFERENCES, type HouseholdPreferences, supportedTimezones, updateHouseholdPreferences } from "#/server/household/preferences";
import { weekdayName } from "#/lib/plan/labels";
import { Button } from "#/components/ui/button";
import { Select } from "#/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "#/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip";
import { useIsMobile } from "#/lib/hooks/use-mobile";

/**
 * The "This week" side panel — stats, week-level actions, household preferences.
 *
 * Open/closed lives in the URL (`?panel=1`, D15) and is owned by the route, so
 * the panel is a controlled component with no state of its own beyond the
 * preference form. The design couples the panel to the view toggle; that is
 * deliberately NOT copied — a panel that vanishes when you switch to Days is a
 * panel you cannot use from Days.
 *
 * Three renderings of one body:
 * - open, `md` and up: a docked 17rem `<aside>`.
 * - closed, `md` and up: a 34px rail, so the panel is one click away and the
 *   week's recipe count stays legible without opening it.
 * - below `md`: a right-hand `Sheet` (the wireframes' phone treatment), because
 *   17rem of a 360px viewport is not a side panel, it is the whole screen.
 */

interface ThisWeekPanelProps {
  week: PlanWeek;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Opens the copy-week dialog (the route owns the dialog and the mutation). */
  onCopyWeek(): void;
  /** Plain success toast — no refetch (the `.ics` download changes nothing). */
  onNotify(message: string): void;
  /** Success toast AND `router.invalidate()`: the grid re-buckets on a save. */
  onPreferencesSaved(message: string): void;
  onError(message: string): void;
}

/** Card chrome, repeated three times — identical to the comp's inline style. */
const CARD = "flex flex-col gap-1.5 rounded-xl border-2 border-border bg-card p-2.5 shadow-pop-sm";
const SECTION_LABEL = "m-0 text-[0.625rem] font-bold tracking-[0.05em] text-muted-foreground uppercase";
const NOTE = "m-0 text-[0.6875rem] text-muted-foreground";

export function ThisWeekPanel({ week, open, onOpenChange, ...handlers }: ThisWeekPanelProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" showCloseButton={false} className="gap-0 overflow-auto p-3">
          <SheetTitle className="sr-only">This week</SheetTitle>
          <PanelBody week={week} onClose={() => onOpenChange(false)} {...handlers} />
        </SheetContent>
      </Sheet>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        aria-label="Show this week panel"
        aria-expanded={false}
        onClick={() => onOpenChange(true)}
        className="hidden w-[34px] flex-none cursor-(--cursor-interactive) flex-col items-center gap-2 border-l-2 border-border bg-muted py-3 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:flex"
      >
        <PanelLeft className="size-[15px] shrink-0" aria-hidden="true" />
        <span className="rotate-180 text-[0.6875rem] font-bold tracking-[0.04em] [writing-mode:vertical-rl]">This week · {week.recipeEntryCount}</span>
      </button>
    );
  }

  return (
    // `bg-muted/45` is the comp's `color-mix(in oklab, var(--muted) 45%, var(--background))`:
    // the panel sits directly on the app background, so the alpha and the mix
    // resolve to the same colour in both themes.
    <aside aria-label="This week" className="hidden w-[17rem] min-h-0 flex-none flex-col gap-2.5 overflow-auto border-l-2 border-border bg-muted/45 p-3 md:flex">
      <PanelBody week={week} onClose={() => onOpenChange(false)} {...handlers} />
    </aside>
  );
}

function PanelBody({ week, onClose, onCopyWeek, onNotify, onPreferencesSaved, onError }: Omit<ThisWeekPanelProps, "open" | "onOpenChange"> & { onClose(): void }) {
  return (
    <>
      <div className="flex flex-none items-center justify-between gap-2">
        <h2 className={SECTION_LABEL}>This week</h2>
        <Button variant="ghost" size="icon-xs" aria-label="Hide this week panel" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>

      <div className={CARD}>
        <p className="display-title m-0 text-2xl leading-none">
          {week.recipeEntryCount} {week.recipeEntryCount === 1 ? "recipe" : "recipes"}
        </p>
        <p className={NOTE}>{week.emptySlotCount === 0 ? "Every slot is filled." : `${week.emptySlotCount} of 28 slots still empty`}</p>
        <p className={NOTE}>{week.cookedCount === 0 ? "Nothing marked cooked yet." : `${week.cookedCount} marked cooked`}</p>
      </div>

      <div className={CARD}>
        <Button size="sm" className="w-full justify-start" onClick={onCopyWeek}>
          <Copy data-icon="inline-start" aria-hidden="true" />
          Copy this week…
        </Button>

        {/*
          The shopping list is not built yet (§7 leaves it to a later project),
          and a button that silently does nothing is worse than one that says so.
          `focusableWhenDisabled` renders `aria-disabled` instead of the native
          `disabled` attribute, so the control still takes focus and still fires
          hover/focus — which is the only way its tooltip can ever be read. The
          Base UI button suppresses the click either way.
        */}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="outline" size="sm" disabled focusableWhenDisabled className="w-full justify-start aria-disabled:cursor-not-allowed aria-disabled:opacity-50" />
            }
          >
            <ShoppingBasket data-icon="inline-start" aria-hidden="true" />
            Add all {week.recipeEntryCount} to shopping list
          </TooltipTrigger>
          <TooltipContent side="left">Shopping list is coming soon — this will take every recipe in the visible week.</TooltipContent>
        </Tooltip>

        {/*
          A plain download link, not a fetch: the `.ics` route (§9.3) already
          sets `Content-Disposition`, so the browser names the file and the
          download survives a slow network with no client state to unwind.
        */}
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<a href={`/api/plan/week.ics?week=${week.weekStart}`} download />}
          className="w-full justify-start"
          onClick={() => onNotify("Week added to your calendar (.ics)")}
        >
          <CalendarRange data-icon="inline-start" aria-hidden="true" />
          Add to calendar
        </Button>
      </div>

      <PreferencesCard week={week} onSaved={onPreferencesSaved} onError={onError} />
    </>
  );
}

// --- §6.11 household preferences ----------------------------------------

const subscribeNothing = () => () => {};

/**
 * False during SSR and the hydration pass, true afterwards.
 *
 * The zone list comes from the platform's ICU data, and the server's and the
 * browser's do not have to agree — a mismatch in ~400 `<option>` children is a
 * hydration error. Rendering the saved zone alone until hydration sidesteps it
 * without shipping the list through the loader. `useSyncExternalStore` rather
 * than an effect: AGENTS.md's `use-mobile.ts` rule, and it keeps this off the
 * `react-hooks/set-state-in-effect` path.
 */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
}

/**
 * The ~400-entry IANA list, grouped by area ("America", "Europe", …).
 *
 * §10.3 leaves the presentation open between a searchable combobox and a
 * grouped select. This is the grouped native `<select>`: the DS has no combobox
 * primitive and P3 may not add one, native selects already have type-ahead (so
 * "searchable" is free and works with one keystroke), phones render the list as
 * a native picker, and the whole thing needs no custom ARIA to be operable.
 */
function timezoneGroups(current: string): Array<{ area: string; zones: Array<{ value: string; label: string }> }> {
  // A zone that the platform has since dropped must still be selectable, or
  // saving any other preference would silently rewrite it. The default zone is
  // pinned for the same reason from the other side: most platforms list
  // "Etc/UTC" but not plain "UTC", so without this, leaving the default once
  // would make it unreachable.
  const all = new Set([...supportedTimezones(), DEFAULT_HOUSEHOLD_PREFERENCES.timezone, current]);
  const groups = new Map<string, Array<{ value: string; label: string }>>();
  for (const zone of [...all].sort()) {
    const [head, ...rest] = zone.split("/");
    const area = rest.length ? head.replace(/_/g, " ") : "Other";
    const label = (rest.length ? rest.join(" / ") : zone).replace(/_/g, " ");
    const bucket = groups.get(area);
    if (bucket) bucket.push({ value: zone, label });
    else groups.set(area, [{ value: zone, label }]);
  }
  return [...groups].map(([area, zoneList]) => ({ area, zones: zoneList }));
}

function PreferencesCard({ week, onSaved, onError }: { week: PlanWeek; onSaved(message: string): void; onError(message: string): void }) {
  // The loader is the source of truth, but it only catches up after the save's
  // `router.invalidate()` lands. `pending` holds what the user just chose so the
  // controls do not visibly snap back in between; a failed save clears it.
  const [pending, setPending] = useState<HouseholdPreferences | null>(null);
  const [saving, setSaving] = useState(false);
  const hydrated = useHydrated();
  const prefs = pending ?? { weekStartDay: week.weekStartDay, timezone: week.timezone };
  const groups = useMemo(() => (hydrated ? timezoneGroups(prefs.timezone) : []), [hydrated, prefs.timezone]);

  async function save(next: HouseholdPreferences, message: string) {
    setPending(next);
    setSaving(true);
    try {
      await updateHouseholdPreferences({ data: next });
      onSaved(message);
    } catch (error) {
      setPending(null);
      onError(error instanceof Error ? error.message : "That didn’t save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={CARD}>
      <p className={SECTION_LABEL}>Household preferences</p>
      <p className={NOTE}>
        {weekdayName(prefs.weekStartDay)} start · {prefs.timezone}
      </p>

      <label className="flex flex-col gap-1 text-xs font-semibold">
        Week starts
        <Select
          size="sm"
          value={String(prefs.weekStartDay)}
          disabled={saving}
          onChange={(event) => {
            const weekStartDay = Number(event.target.value);
            void save({ ...prefs, weekStartDay }, `Weeks start ${weekdayName(weekStartDay)}`);
          }}
        >
          {[1, 2, 3, 4, 5, 6, 7].map((day) => (
            <option key={day} value={day}>
              {weekdayName(day)}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-xs font-semibold">
        Timezone
        <Select size="sm" value={prefs.timezone} disabled={saving} onChange={(event) => void save({ ...prefs, timezone: event.target.value }, "Timezone saved")}>
          {hydrated ? (
            groups.map((group) => (
              <optgroup key={group.area} label={group.area}>
                {group.zones.map((zone) => (
                  <option key={zone.value} value={zone.value}>
                    {zone.label}
                  </option>
                ))}
              </optgroup>
            ))
          ) : (
            <option value={prefs.timezone}>{prefs.timezone}</option>
          )}
        </Select>
      </label>

      <p className={NOTE}>Both are household-wide. Changing the week start re-buckets the grid — it never moves a meal.</p>
    </div>
  );
}
