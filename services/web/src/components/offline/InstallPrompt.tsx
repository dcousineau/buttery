import { useEffect, useState } from "react";
import { EllipsisVertical, Share, SquarePlus, X } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "#/components/ui/dialog";
import { readInstallPromptDismissed, writeInstallPromptDismissed } from "#/lib/offline/install-prompt-dismissal";
import { useSessionSnapshot } from "#/lib/offline/use-household";
import { useServiceWorker } from "#/lib/offline/use-service-worker";
import { useHydrated } from "#/lib/hooks/use-hydrated";

/**
 * "Buttery can live on your home screen" (offline plan §4.4) — a floating chip,
 * and the instructions modal behind it.
 *
 * **This is a data-durability feature, not a growth prompt.** Safari erases
 * IndexedDB, localStorage, Cache Storage and service-worker registrations for
 * any site not interacted with for seven days. A home-screen web app is outside
 * Safari and keeps its own usage counter, so it is exempt (§9.1). Installing is
 * therefore the difference between a phone that still has your shopping list in
 * a store next week and one that does not.
 *
 * The shape is a two-step offer, deliberately: a low-key pinned chip (same
 * furniture as `UpdateBanner` — no backdrop, `--z-banner`, never over a modal),
 * and a modal with the actual instructions only for whoever asks. The previous
 * version opened a full bottom sheet unprompted, which spent the app's one
 * chance to explain the seven-day rule on people mid-task.
 *
 * Three gates on the chip, each with a reason:
 *
 * - **Signed in only.** The pitch is "your recipe box, readable offline" —
 *   a visitor with no box gets marketing chrome over the landing page instead
 *   of an offer about their data.
 * - **Dismissal is forever**, stored in localStorage *and* its own IndexedDB
 *   database (`install-prompt-dismissal.ts` — why two, and why neither is
 *   touched by the cache wipes). An install nag that reappears is an install
 *   nag people learn to swipe away without reading.
 * - **Never beside the update banner** (`updateReady`): both pin to the same
 *   bottom strip, and two competing cards there is exactly the clutter this
 *   redesign removes. The update offer wins; the chip returns after the reload.
 *
 * The modal swaps its instructions by platform: iOS (every browser there can
 * Add to Home Screen since 16.4, all via the share sheet), Chromium's real
 * `beforeinstallprompt` button where the event fired, and the browser-menu
 * fallback for the Androids without it (Firefox). Installing removes the
 * trigger condition itself (`display-mode: standalone`).
 */

const isStandaloneQuery = "(display-mode: standalone)";

/** Chrome's install event, which is not in `lib.dom`. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone(): boolean {
  if (window.matchMedia(isStandaloneQuery).matches) return true;
  // iOS Safari's own, pre-standard flag. Still the only reliable signal there.
  return (window.navigator as { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
  const ua = window.navigator.userAgent;
  // No Safari-only carve-out: since iOS/iPadOS 16.4 the share sheet's "Add to
  // Home Screen" works from third-party browsers too — they are all WebKit
  // underneath and all have a share button, so one set of instructions holds.
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && "ontouchend" in document);
}

function isAndroid(): boolean {
  return /Android/i.test(window.navigator.userAgent);
}

export function InstallPrompt() {
  const hydrated = useHydrated();
  const signedIn = useSessionSnapshot()?.did != null;
  const { updateReady } = useServiceWorker();
  // `null` = "haven't read the stores yet". The chip stays hidden until the
  // answer is a definite no — a flash-then-vanish chip reads as a glitch.
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readInstallPromptDismissed().then((stored) => {
      if (!cancelled) setDismissed(stored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Chromium only. iOS never fires this — there, eligibility is derived
    // during render below, because it is a property of the browser rather than
    // an event that arrives.
    function capture(event: Event) {
      // Chrome shows its own mini-infobar unless this is prevented; ours says
      // why installing matters, which theirs does not.
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    }
    window.addEventListener("beforeinstallprompt", capture);
    return () => window.removeEventListener("beforeinstallprompt", capture);
  }, []);

  function dismissForever() {
    setDismissed(true);
    setOpen(false);
    writeInstallPromptDismissed();
  }

  async function install() {
    if (!installEvent) return;
    await installEvent.prompt();
    // Either answer to the *native* prompt is final: accepted means installed
    // (standalone hides the chip anyway), declined is a rejection like any other.
    await installEvent.userChoice;
    dismissForever();
  }

  // Derived at render, not stored: every input is a synchronous browser fact,
  // and `hydrated` short-circuits the chain so none of it runs during SSR or
  // the hydration pass.
  const eligible = hydrated && signedIn && dismissed === false && !updateReady && !isStandalone();
  const platform = !eligible ? null : isIos() ? "ios" : installEvent ? "prompt" : isAndroid() ? "android" : null;
  if (!platform) return null;

  return (
    <>
      {/* The same furniture as UpdateBanner, for the same reasons: pinned, no
          backdrop, `--z-banner` so cook mode's fullscreen dialog outranks it,
          `pointer-events-none` wrapper so the strip beside the card stays
          tappable, and clear of the iOS home indicator in a standalone window. */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-(--z-banner) flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      >
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border-2 border-border bg-secondary px-3 py-2 text-secondary-foreground shadow-pop">
          <SquarePlus className="size-4 shrink-0" aria-hidden="true" />
          <p className="m-0 mr-1 text-[0.8125rem] font-semibold">Buttery can live on your home screen</p>
          <Button size="sm" onClick={() => setOpen(true)}>
            Show me
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Don't show this again" onClick={dismissForever}>
            <X aria-hidden="true" />
          </Button>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Keep Buttery on your home screen</DialogTitle>
          <DialogDescription>
            Installed, your recipe box, this week's plan and the shopping list stay readable with no signal — and this device stops forgetting them after a week unopened.
          </DialogDescription>

          {platform === "ios" ? (
            // No programmatic install exists on iOS. Two taps, named, in order.
            <ol className="m-0 flex list-none flex-col gap-2 p-0 text-sm font-semibold text-foreground">
              <li className="flex items-center gap-2">
                <Share className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                Tap Share in the browser bar
              </li>
              <li className="flex items-center gap-2">
                <SquarePlus className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                Choose “Add to Home Screen”
              </li>
            </ol>
          ) : platform === "android" ? (
            // An Android browser that never fired `beforeinstallprompt`
            // (Firefox, mostly). The wording differs per browser; the menu
            // does not.
            <ol className="m-0 flex list-none flex-col gap-2 p-0 text-sm font-semibold text-foreground">
              <li className="flex items-center gap-2">
                <EllipsisVertical className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                Open your browser's menu
              </li>
              <li className="flex items-center gap-2">
                <SquarePlus className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                Choose “Add to Home screen” or “Install app”
              </li>
            </ol>
          ) : (
            <Button onClick={() => void install()}>Install Buttery</Button>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={dismissForever}>
              Don't ask again
            </Button>
            <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
