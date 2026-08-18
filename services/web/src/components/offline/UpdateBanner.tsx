import { RefreshCw } from "lucide-react";
import { Button } from "#/components/ui/button";
import { useServiceWorker } from "#/lib/offline/use-service-worker";

/**
 * "New version available — Reload" (offline plan §4.4).
 *
 * The service worker never calls `skipWaiting()`. A new build installs, then
 * sits in `waiting` until someone presses this button — because the alternative
 * is swapping the JS bundle under a 40-minute bake with a timer pending, and
 * nobody's bread is worth a deploy window.
 *
 * A pinned banner rather than a toast, deliberately: a toast is transient, and
 * this is a standing offer that stays true until it is taken. It also has to
 * survive every route, and toast viewports here are per-route.
 *
 * `aria-live="polite"` because the update is genuinely news, but news that can
 * wait for a gap in whatever the screen reader is already saying — an
 * `assertive` interruption for "a new version exists" would be rude in the
 * middle of a recipe step.
 */
export function UpdateBanner() {
  const { updateReady, applyUpdate } = useServiceWorker();
  if (!updateReady) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      // Above the safe-area inset so it clears the iOS home indicator in a
      // standalone window, where there is no browser chrome under it.
      className="fixed inset-x-0 bottom-0 z-(--z-toast) flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <div className="flex items-center gap-3 rounded-lg border-2 border-border bg-secondary px-3 py-2 text-secondary-foreground shadow-pop">
        <RefreshCw className="size-4 shrink-0" aria-hidden="true" />
        <p className="m-0 text-[0.8125rem] font-semibold">A new version of Buttery is ready</p>
        <Button size="sm" onClick={applyUpdate}>
          Reload
        </Button>
      </div>
    </div>
  );
}
