import { useEffect, useState } from "react";
import { CookingPot } from "lucide-react";
import { useAnalytics } from "#/lib/analytics";
import { Button } from "#/components/ui/button";
import { CookModeOverlay } from "./CookModeOverlay";
import type { CookRecipe } from "./cook/CookMode";

/**
 * "Apron on" — the launch surface for cook mode (plan §4.1, §5). This is the ONLY
 * thing the detail pane imports; the overlay it mounts is lazy, so the
 * `/household/recipes/{id}` bundle and first paint pay nothing for it.
 *
 * `autoOpen` is the `?cook` deep link (meal planner §7.5), kept for links that
 * arrive from outside the app. It is the mount-time value only — the route drops
 * the param when cook mode closes (`onAutoOpenConsumed`), so closing does not
 * immediately re-open, and a reload after that lands on the plain recipe. The
 * planner no longer uses this path: its cook shortcut opens the apron in place
 * over the week, so closing returns to the plan rather than stranding someone on
 * a recipe page they never asked to visit.
 */
export function CookModeLauncher({
  recipe,
  autoOpen = false,
  analyticsSource = "button",
  onAutoOpenConsumed,
  onOpened,
}: {
  recipe: CookRecipe;
  autoOpen?: boolean;
  /**
   * The `source` value the button path's `cook_mode_opened` carries — i.e.
   * WHERE the apron was tapped. This component is mounted on more than one
   * surface (the household recipe page, the public recipe page, the randomizer
   * via `DetailPane`), and a literal here reported all of them as the same
   * place, which is worse than a missing event: the number looks right and is
   * attributed to the wrong surface.
   *
   * The event's `source` vocabulary is already caller-supplied and already
   * mixes in surface names — `/household/plan` captures the same event with
   * `source: "plan_card"` from the route. So callers name themselves here, and
   * the default is the historical `"button"` so `/household/recipes/$id` is
   * byte-for-byte unchanged.
   *
   * Not to be confused with `onOpened` below: that reports the gesture under the
   * CALLER's own event name, and both exist.
   */
  analyticsSource?: string;
  onAutoOpenConsumed?: () => void;
  /**
   * Fired alongside this component's own `cook_mode_opened` capture, for a
   * surface that also has to record the launch under its own event name — the
   * randomizer's `randomizer_result_action` (randomizer plan §9). Optional and
   * unset everywhere else, so the recipe page's behaviour is unchanged.
   *
   * NOT a replacement for `cook_mode_opened`: that event is about cook mode and
   * belongs here; this one is about which surface the reader acted from, and
   * belongs to the caller.
   */
  onOpened?: () => void;
}) {
  const { posthog } = useAnalytics();
  const [open, setOpen] = useState(autoOpen);

  // The button path captures on the gesture; a deep link has no gesture to hang
  // it on, so it is captured on mount with the source recorded. `"deep_link"`
  // stays a literal on purpose — unlike the button, it names how the reader
  // ARRIVED (the `?cook` param, from outside the app) rather than which surface
  // they were on, and it is reachable only from the one route that passes
  // `autoOpen`. A surface that starts deep-linking wants its own value here.
  useEffect(() => {
    if (autoOpen) posthog.capture("cook_mode_opened", { recipe_id: recipe.recipeId, source: "deep_link" });
  }, [autoOpen, posthog, recipe.recipeId]);

  function openCookMode() {
    posthog.capture("cook_mode_opened", { recipe_id: recipe.recipeId, source: analyticsSource });
    onOpened?.();
    setOpen(true);
  }

  function closeCookMode() {
    setOpen(false);
    onAutoOpenConsumed?.();
  }

  return (
    <>
      <Button size="lg" onClick={openCookMode}>
        <CookingPot data-icon="inline-start" aria-hidden="true" />
        Apron on
      </Button>
      {open && <CookModeOverlay recipe={recipe} onClose={closeCookMode} />}
    </>
  );
}
