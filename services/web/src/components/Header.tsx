import { Link } from "@tanstack/react-router";
import { authClient } from "../lib/auth-client";
import ButterStick from "./ButterStick";
import HouseholdSwitcher from "./HouseholdSwitcher";
import UserMenu from "./UserMenu";
import { HeaderTimerIndicator } from "./timers/HeaderTimerIndicator";
import type { ReactNode, Ref } from "react";

/** The wordmark's destination depends on auth: a signed-in user goes to their
 * logged-in landing (`/pantry`, which itself routes on to the household picker /
 * onboarding when there's no active household); a signed-out (or still-loading)
 * visitor goes to the public marketing home (`/`). */
function Wordmark() {
  const { data: session } = authClient.useSession();
  return (
    <Link to={session ? "/pantry" : "/"} className="flex items-center gap-2 text-foreground no-underline">
      <ButterStick className="h-6 w-auto" />
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
      className="fixed inset-x-0 top-0 z-50 border-b-2 border-border bg-background transition-transform duration-200 ease-linear data-[hidden]:-translate-y-full"
    >
      <div className="flex items-center gap-2 px-3 py-2.5 sm:px-5">
        {leftSlot}
        <Wordmark />

        <div className="ml-auto flex items-center gap-2">
          <HeaderTimerIndicator />
          <HouseholdSwitcher />
          <UserMenu />
        </div>
      </div>
      <div className="gingham-band" aria-hidden="true" />
    </header>
  );
}
