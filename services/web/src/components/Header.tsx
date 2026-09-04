import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { useHeadroom } from "@mantine/hooks";
import { useHydratedSession } from "../lib/auth-client";
import { useSessionSnapshot } from "#/lib/offline/use-household";
import UserMenu from "./UserMenu";
import { HeaderTimerIndicator } from "./timers/HeaderTimerIndicator";
import { useReducedMotion } from "#/lib/hooks/use-reduced-motion";
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
 * Publishes `--header-progress` (1 shown → 0 slid away) and renders nothing.
 *
 * A component of its own, and a childless one, on purpose: `useHeadroom` reads
 * `useWindowScroll`, which sets state on **every** scroll event. Subscribing in
 * `Header` would re-render the wordmark, the timer indicator and the user menu
 * once per frame of every scroll, and subscribing in `AppShell` would re-render
 * the whole route. Here the per-frame render costs one `null`, and everything
 * that follows the header — its own transform, every sticky pane head, the
 * aisle rules — reads the CSS variable instead of React state.
 *
 * `prefers-reduced-motion` pins it open: chrome that moves itself is exactly
 * what that setting is asking us not to do.
 */
function HeadroomProbe() {
  const reducedMotion = useReducedMotion();
  const { scrollProgress } = useHeadroom({ fixedAt: 0 });
  const progress = reducedMotion ? 1 : scrollProgress;
  useEffect(() => {
    document.documentElement.style.setProperty("--header-progress", String(progress));
  }, [progress]);
  // Hand the variable back on the way out, or a route that mounts no probe
  // inherits whatever the last scrolled one left behind — navigate from a
  // scrolled-down app view to the landing and the bar would still be off-screen,
  // with nothing left running to bring it back. Removing the property restores
  // the `:root` default, which is a fully shown header.
  useEffect(
    () => () => {
      document.documentElement.style.removeProperty("--header-progress");
    },
    [],
  );
  return null;
}

/**
 * Full-width top bar shared by every layout. Fixed to the viewport top (above
 * the sidebar) and owns the wordmark — `fixed` (not `sticky`) so macOS
 * overscroll doesn't rubber-band it with the body. `leftSlot` is where the app
 * shell injects the mobile sidebar trigger; nav-less layouts leave it empty.
 *
 * `headroom` slides it away as you scroll down and brings it back on a flick up
 * — the behaviour the old `hidden` prop was left here for and never got, because
 * until the document scrolled there was no scroll for it to read.
 *
 * **It is off by default, and `AppShell` turns it on for app views only.** A
 * scrolling page whose job is browsing — the landing at `/household`, the
 * marketing and legal pages — is one where this bar is the navigation, and
 * navigation that moves on its own is a worse trade than the ~80px it wins
 * back. The app views are where the trade pays: they are read one column at a
 * time on a phone, and the head under this one is already getting out of the
 * way.
 *
 * The transform is a `transform`, never a height: the document's height is what
 * a scroll position is measured against, so collapsing the header would move
 * the thing being measured and the reveal would fight the finger. Nothing under
 * it reflows either — the shell's `padding-top` still reserves the full height,
 * so the content simply scrolls beneath.
 *
 * No transition, deliberately: the progress tracks scroll continuously, so the
 * bar follows the finger. An easing curve on top of that reads as lag.
 */
export default function Header({ ref, leftSlot, headroom = false }: { ref?: Ref<HTMLElement>; leftSlot?: ReactNode; headroom?: boolean }) {
  return (
    <header ref={ref} className="fixed inset-x-0 top-0 z-(--z-sticky) translate-y-[calc((var(--header-progress,1)-1)*100%)] border-b-2 border-border bg-background">
      {headroom && <HeadroomProbe />}
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
