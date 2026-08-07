import { lazy, Suspense } from "react";
import { ClientOnly } from "@tanstack/react-router";
import { Spinner } from "#/components/ui/spinner";
import type { CookRecipe } from "./cook/CookMode";

/**
 * The heavy cook-mode subtree (audio, wake lock, the large step renderer,
 * ambient CSS) sits behind `React.lazy` + `<Suspense>` and is fetched as a
 * single chunk only when someone actually puts the apron on — it costs the
 * recipe and planner bundles nothing at first paint.
 *
 * `<ClientOnly>` (belt-and-suspenders with the lazy boundary) guarantees the
 * browser-only cook subtree only mounts after hydration, never during SSR
 * (§4.1a). This is the codebase's first `React.lazy`/`Suspense` — keep it as
 * the template.
 *
 * It lives here rather than inside `CookModeLauncher` because cook mode opens
 * from two places now: the recipe page's "Apron on" button, and a plan card's
 * cook shortcut. Both mount this, so both share one chunk and one definition of
 * what "opening cook mode" means.
 */
const CookMode = lazy(() => import("./cook/CookMode"));

/**
 * What the screen shows between the gesture and the chunk arriving. Deliberately
 * full-screen and `dark`, matching cook mode itself: the apron is a mode change,
 * and a spinner in the page's own colours would read as the page hanging.
 */
export function CookModeFallback() {
  return (
    <div className="dark fixed inset-0 z-[70] grid place-content-center bg-background text-foreground" role="status" aria-label="Opening cook mode">
      <Spinner className="size-8 text-primary" />
    </div>
  );
}

export function CookModeOverlay({ recipe, onClose }: { recipe: CookRecipe; onClose: () => void }) {
  return (
    <ClientOnly fallback={<CookModeFallback />}>
      <Suspense fallback={<CookModeFallback />}>
        <CookMode recipe={recipe} onClose={onClose} />
      </Suspense>
    </ClientOnly>
  );
}
