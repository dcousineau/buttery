import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezonePlugin from "dayjs/plugin/timezone.js";
import { CalendarCheck } from "lucide-react";
import { addMealPlanRecipes, getPlanToday, keys } from "#/lib/api";
import { useAnalytics } from "#/lib/analytics";
import { useRecipesView } from "#/components/recipes/context";
import { slotForHour } from "#/lib/plan/week";
import { SLOT_LABELS, longDow } from "#/lib/plan/labels";
import { Button } from "#/components/ui/button";
import { Spinner } from "#/components/ui/spinner";

dayjs.extend(utc);
dayjs.extend(timezonePlugin);

/**
 * The §8 shortcut — "Add to today's &lt;slot&gt;", beside "Roll again". The
 * ONLY randomizer-owned write action (§7.2, §8: `AddToPlanDialog` stays
 * available from the result pane for any other day/slot; this is a shortcut,
 * not a replacement, and no other of `DetailPane`'s actions are duplicated
 * here).
 *
 * `getPlanToday()` — never `new Date().getHours()` (§8, and the whole reason
 * `slotForHour` takes a plain hour rather than reading the clock itself): the
 * household-local hour is computed from `timezone` with the same dayjs +
 * utc/timezone plugins `lib/plan/week.ts` uses, imported the same way.
 *
 * Disabled with a neutral label until `getPlanToday()` resolves — guessing a
 * slot and relabelling it under the user's cursor once the real answer lands
 * is worse than a brief disabled state (§8).
 */
export function RandomizerPlanShortcut({ householdId, recipeId }: { householdId: string; recipeId: string }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { pushToast } = useRecipesView();
  const { posthog } = useAnalytics();
  const [adding, setAdding] = useState(false);

  const { data: planToday } = useQuery({
    queryKey: ["household", householdId, "plan-today"],
    queryFn: getPlanToday,
    // "Today" only changes at midnight in the household's zone; no need to
    // treat it as fast-moving data.
    staleTime: 5 * 60_000,
  });

  if (!planToday) {
    return (
      <Button variant="outline" disabled title="Working out today's date…">
        <CalendarCheck data-icon="inline-start" aria-hidden="true" />
        Add to plan…
      </Button>
    );
  }

  const hour = dayjs().tz(planToday.timezone).hour();
  const slot = slotForHour(hour);
  const slotLabel = SLOT_LABELS[slot].toLowerCase();

  async function onAdd() {
    if (!planToday) return;
    setAdding(true);
    try {
      await addMealPlanRecipes({ date: planToday.today, slot, recipeIds: [recipeId] });
      posthog.capture("randomizer_result_action", { action: "plan_today", recipe_id: recipeId, slot });
      await queryClient.invalidateQueries({ queryKey: keys.household.planAll(householdId) });
      pushToast(`Added to ${longDow(planToday.today)} ${slotLabel}`, {
        action: { label: "View plan", onClick: () => void router.navigate({ to: "/household/plan" }) },
      });
    } catch {
      pushToast("Couldn't add that to the plan. Try again.", { variant: "destructive" });
    } finally {
      setAdding(false);
    }
  }

  return (
    <Button variant="outline" disabled={adding} onClick={onAdd}>
      {adding ? <Spinner /> : <CalendarCheck data-icon="inline-start" aria-hidden="true" />}
      {adding ? "Adding…" : `Add to today's ${slotLabel}`}
    </Button>
  );
}
