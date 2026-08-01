import { lazy, Suspense, useState } from "react";
import { ClientOnly } from "@tanstack/react-router";
import { CookingPot } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Spinner } from "#/components/ui/spinner";
import type { HouseholdRecipeDetail } from "#/server/household-recipes";

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

export function CookModeLauncher({ recipe }: { recipe: HouseholdRecipeDetail }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button size="lg" onClick={() => setOpen(true)}>
        <CookingPot data-icon="inline-start" aria-hidden="true" />
        Apron on
      </Button>
      {open && (
        <ClientOnly fallback={<CookModeFallback />}>
          <Suspense fallback={<CookModeFallback />}>
            <CookMode recipe={recipe} onClose={() => setOpen(false)} />
          </Suspense>
        </ClientOnly>
      )}
    </>
  );
}
