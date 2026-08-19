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
    // the wordmark breaks mid-word ("Butter / y").
    <Link to={signedIn ? "/household" : "/"} className="flex shrink-0 items-center whitespace-nowrap text-foreground no-underline">
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
 * `hidden` is wired for a future scroll-direction collapse (slides the bar out
 * of view); the transition is already here — nothing drives it yet.
 */
export default function Header({ ref, leftSlot, hidden = false }: { ref?: Ref<HTMLElement>; leftSlot?: ReactNode; hidden?: boolean }) {
  return (
    <header
      ref={ref}
      data-hidden={hidden || undefined}
      className="fixed inset-x-0 top-0 z-(--z-sticky) border-b-2 border-border bg-background transition-transform duration-200 ease-linear data-[hidden]:-translate-y-full"
    >
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
