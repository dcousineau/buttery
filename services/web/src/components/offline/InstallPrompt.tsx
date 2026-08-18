import { useEffect, useState } from "react";
import { Share, SquarePlus, X } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "#/components/ui/sheet";
import { readJSON, writeJSON } from "#/lib/timers/storage";
import { useHydrated } from "#/lib/hooks/use-hydrated";

/**
 * "Add Buttery to your home screen" (offline plan §4.4).
 *
 * **This is a data-durability feature, not a growth prompt.** Safari erases
 * IndexedDB, localStorage, Cache Storage and service-worker registrations for
 * any site not interacted with for seven days. A home-screen web app is outside
 * Safari and keeps its own usage counter, so it is exempt (§9.1). Installing is
 * therefore the difference between a phone that still has your shopping list in
 * a store next week and one that does not — which is why iOS gets a hand-built
 * sheet rather than being left to discover the share menu.
 *
 * iOS has no `beforeinstallprompt` and no programmatic install: the only way in
 * is Share → Add to Home Screen, so the sheet's whole job is to name those two
 * taps. Chrome and Android *do* fire `beforeinstallprompt`, and it is captured
 * here because doing so is three lines; when it is available the sheet gets a
 * real button instead of instructions.
 *
 * It shows once. Dismissal is remembered for 90 days, and installing removes the
 * condition that triggers it at all (`display-mode: standalone`). An install
 * nag that reappears is an install nag people learn to swipe away without
 * reading, which would waste the one chance to explain the seven-day rule.
 */

const DISMISSED_KEY = "buttery:install-prompt-dismissed";
const DISMISS_DAYS = 90;

/** Chrome's install event, which is not in `lib.dom`. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone(): boolean {
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  // iOS Safari's own, pre-standard flag. Still the only reliable signal there.
  return (window.navigator as { standalone?: boolean }).standalone === true;
}

function isIosSafari(): boolean {
  const ua = window.navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && "ontouchend" in document);
  // Chrome and Firefox on iOS are Safari underneath but cannot install to the
  // home screen at all, so pointing them at the share sheet would be a lie.
  return iOS && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

function dismissedRecently(): boolean {
  const stored = readJSON<{ at: number }>(DISMISSED_KEY);
  if (!stored) return false;
  return Date.now() - stored.at < DISMISS_DAYS * 24 * 60 * 60 * 1000;
}

export function InstallPrompt() {
  const hydrated = useHydrated();
  const [dismissed, setDismissed] = useState(false);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    // Chrome/Android only. iOS never fires this — there, eligibility is derived
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

  // Derived at render, not stored in an effect: every input is a synchronous
  // browser fact, and setting state from an effect to mirror one is the
  // cascading-render pattern React (and the compiler's lint) asks us not to
  // write. `hydrated` short-circuits the whole chain, so nothing here runs on
  // the server or during the hydration pass — which also keeps the
  // `createClientOnlyFn` storage reads from throwing.
  const eligible = hydrated && !dismissed && !isStandalone() && !dismissedRecently();
  const ios = eligible && isIosSafari();
  const open = eligible && (ios || installEvent !== null);

  function dismiss() {
    setDismissed(true);
    writeJSON(DISMISSED_KEY, { at: Date.now() });
  }

  async function install() {
    if (!installEvent) return;
    await installEvent.prompt();
    await installEvent.userChoice;
    dismiss();
  }

  return (
    <Sheet open={open} onOpenChange={(next) => !next && dismiss()}>
      <SheetContent side="bottom" showCloseButton={false} className="gap-0 p-0">
        <div className="mx-auto flex w-full max-w-md flex-col gap-3 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <SheetTitle className="display-title text-lg">Keep Buttery on your home screen</SheetTitle>
              <SheetDescription>
                Installed, your recipe box, this week's plan and the shopping list stay readable with no signal — and this phone stops forgetting them after a week unopened.
              </SheetDescription>
            </div>
            <Button variant="ghost" size="icon-sm" aria-label="Not now" onClick={dismiss}>
              <X aria-hidden="true" />
            </Button>
          </div>

          {ios ? (
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
          ) : (
            <Button onClick={() => void install()}>Add to home screen</Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
