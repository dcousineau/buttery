import { RefreshCw, X } from "lucide-react";
import { Button } from "#/components/ui/button";
import { useServiceWorker } from "#/lib/offline/use-service-worker";

/**
 * "A new version of Buttery is ready — Reload" (offline plan §4.4).
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
 * **It must never be the thing between a cook and their controls.** Two rules
 * carry that, and both were wrong before:
 *
 *  - **`--z-banner`, below `--z-modal`.** This sat at `--z-toast` (60), above
 *    the modal layer (50) that cook mode's fullscreen `Dialog` actually renders
 *    on — `--z-takeover` is only the lazy-loading placeholder, not the mode
 *    itself. Pinned to `bottom-0`, that put it directly over `CookPhase`'s step
 *    controls, in the same strip, for anyone who happened to be cooking when a
 *    deploy landed. A standing offer has no business outranking a surface that
 *    has taken over the screen; the offer is still there when the mode ends.
 *  - **A dismiss.** `updateReady` used to clear exactly one way —
 *    `location.reload()` — so the only escape from the banner was the reload
 *    the no-`skipWaiting()` design exists to avoid forcing. Now "Not now" puts
 *    it away for this worker; the build stays waiting, and the *next* build
 *    offers again (`dismissUpdate` tracks by worker identity).
 *
 * `pointer-events-none` on the positioning wrapper, `auto` on the card: the
 * wrapper spans the full width of the bottom of every screen, and a transparent
 * full-width strip that eats taps is its own bug.
 *
 * `aria-live="polite"` because the update is genuinely news, but news that can
 * wait for a gap in whatever the screen reader is already saying — an
 * `assertive` interruption for "a new version exists" would be rude in the
 * middle of a recipe step.
 */
export function UpdateBanner() {
  const { updateReady, applyUpdate, dismissUpdate } = useServiceWorker();
  if (!updateReady) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      // Above the safe-area inset so it clears the iOS home indicator in a
      // standalone window, where there is no browser chrome under it.
      className="pointer-events-none fixed inset-x-0 bottom-0 z-(--z-banner) flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <div className="pointer-events-auto flex items-center gap-2 rounded-lg border-2 border-border bg-secondary px-3 py-2 text-secondary-foreground shadow-pop">
        <RefreshCw className="size-4 shrink-0" aria-hidden="true" />
        <p className="m-0 mr-1 text-[0.8125rem] font-semibold">A new version of Buttery is ready</p>
        <Button size="sm" onClick={applyUpdate}>
          Reload
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Not now" onClick={dismissUpdate}>
          <X aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
