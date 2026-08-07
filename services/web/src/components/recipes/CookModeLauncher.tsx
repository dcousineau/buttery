import { useEffect, useState } from "react";
import { usePostHog } from "@posthog/react";
import { CookingPot } from "lucide-react";
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
export function CookModeLauncher({ recipe, autoOpen = false, onAutoOpenConsumed }: { recipe: CookRecipe; autoOpen?: boolean; onAutoOpenConsumed?: () => void }) {
  const posthog = usePostHog();
  const [open, setOpen] = useState(autoOpen);

  // The button path captures on the gesture; a deep link has no gesture to hang
  // it on, so it is captured on mount with the source recorded.
  useEffect(() => {
    if (autoOpen) posthog.capture("cook_mode_opened", { recipe_id: recipe.recipeId, source: "deep_link" });
  }, [autoOpen, posthog, recipe.recipeId]);

  function openCookMode() {
    posthog.capture("cook_mode_opened", { recipe_id: recipe.recipeId, source: "button" });
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
