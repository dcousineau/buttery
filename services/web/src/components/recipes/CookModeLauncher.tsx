import { lazy, Suspense, useEffect, useState } from "react";
import { ClientOnly } from "@tanstack/react-router";
import { usePostHog } from "@posthog/react";
import { CookingPot } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Spinner } from "#/components/ui/spinner";
import type { CookRecipe } from "./cook/CookMode";

/**
 * "Apron on" — the launch surface for cook mode (plan §4.1, §5). This is the ONLY
 * thing the detail pane imports; the heavy cook-mode subtree (audio, wake lock,
 * the large step renderer, ambient CSS) sits behind `React.lazy` + `<Suspense>`
 * and is fetched as a single chunk only when this button is pressed — it costs
 * the `/household/recipes/{id}` bundle and first paint nothing.
 *
 * `<ClientOnly>` (belt-and-suspenders with the lazy boundary) guarantees the
 * browser-only cook subtree only mounts after hydration, never during SSR (§4.1a).
 * This is the codebase's first `React.lazy`/`Suspense` — keep it as the template.
 */
const CookMode = lazy(() => import("./cook/CookMode"));

function CookModeFallback() {
  return (
    <div className="dark fixed inset-0 z-[70] grid place-content-center bg-background text-foreground" role="status" aria-label="Opening cook mode">
      <Spinner className="size-8 text-primary" />
    </div>
  );
}

/**
 * `autoOpen` is the `?cook=1` deep link (meal planner §7.5): the planner's
 * "Start cook mode" sends someone straight from a plan card into the apron, with
 * no stop on the recipe page. It is the mount-time value only — the route drops
 * the param when cook mode closes (`onAutoOpenConsumed`), so closing does not
 * immediately re-open, and a reload after that lands on the plain recipe.
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
      {open && (
        <ClientOnly fallback={<CookModeFallback />}>
          <Suspense fallback={<CookModeFallback />}>
            <CookMode recipe={recipe} onClose={closeCookMode} />
          </Suspense>
        </ClientOnly>
      )}
    </>
  );
}
