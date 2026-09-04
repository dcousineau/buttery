import { Link } from "@tanstack/react-router";
import { useHydratedSession } from "../lib/auth-client";
import { useSessionSnapshot } from "#/lib/offline/use-household";
import UserMenu from "./UserMenu";
import { HeaderTimerIndicator } from "./timers/HeaderTimerIndicator";
import type { ReactNode, Ref } from "react";

/** The wordmark's destination depends on auth: a signed-in user goes to their
 * logged-in landing (`/household`, which itself routes on to the household picker /
 * onboarding when there's no active household); a signed-out (or still-loading)
 * visitor goes to the public marketing home (`/`). */
function Wordmark() {
  const { data: session } = useHydratedSession();
  // Offline the live session is absent but the person is still signed in, so the
  // wordmark must not send them back to marketing (offline plan §4.4).
  const snapshot = useSessionSnapshot();
  const signedIn = session !== null || snapshot !== null;
  return (
    // `shrink-0` + `nowrap`: on a 390px phone the menus squeeze this down until
    // the wordmark breaks mid-word ("Butter / y"). The touch height is hit box
    // only — the glyphs stay 18px tall, the tappable row grows to the floor.
    <Link to={signedIn ? "/household" : "/"} className="flex shrink-0 items-center whitespace-nowrap text-foreground no-underline touch:min-h-(--control-h-touch)">
      <span className="display-title text-lg leading-none">Buttery</span>
    </Link>
  );
}

/**
 * Full-width top bar shared by every layout. Fixed to the viewport top (above
 * the sidebar) and owns the wordmark — `fixed` (not `sticky`) so macOS
 * overscroll doesn't rubber-band it with the body. `leftSlot` is where the app
 * shell injects the mobile sidebar trigger; nav-less layouts leave it empty.
 *
 * **It never moves.** A headroom pass — sliding it away on scroll down, back on
 * a flick up — was built here and taken out again: this bar is the app's
 * navigation and its identity, and navigation that leaves on its own is a worse
 * trade than the ~80px it wins back, on every surface, not just the browsing
 * ones. What gets out of the way instead is the pane head below it
 * (`ui/pane.tsx`), which is page furniture rather than navigation, and can go
 * without taking the way back with it.
 */
export default function Header({ ref, leftSlot }: { ref?: Ref<HTMLElement>; leftSlot?: ReactNode }) {
  return (
    <header ref={ref} className="fixed inset-x-0 top-0 z-(--z-sticky) border-b-2 border-border bg-background">
      <div className="flex items-center gap-2 px-3 py-2.5 sm:px-5">
        {leftSlot}
        <Wordmark />

        <div className="ml-auto flex min-w-0 items-center gap-2">
          <HeaderTimerIndicator />
          <UserMenu />
        </div>
      </div>
      <div className="gingham-band" aria-hidden="true" />
    </header>
  );
}
