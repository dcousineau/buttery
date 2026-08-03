import { Link } from "@tanstack/react-router";
import ButterStick from "./ButterStick";
import ThemeToggle from "./ThemeToggle";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { signOutAndGoHome } from "#/lib/auth-client";

/**
 * Post-login holding page for a signed-in user who isn't invited yet (the
 * PostHog `invited` flag serves `false` — see `src/lib/gate.ts`). Rendered in
 * place of the app shell on gated routes: they're authenticated, so this is a
 * "sit tight" screen with a way back out (sign out), not the public marketing
 * coming-soon page.
 */
export default function Waitlist() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b-2 border-border bg-background">
        <div className="page-wrap flex items-center gap-2 px-4 py-2.5">
          <ButterStick className="h-7 w-auto" />
          <span className="display-title text-xl leading-none">Buttery</span>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>
        <div className="gingham-band" aria-hidden="true" />
      </header>

      <main id="main-content" tabIndex={-1} className="flex flex-1 items-center focus-visible:outline-none">
        <section className="page-wrap rise-in flex flex-col items-center gap-8 px-4 py-16 text-center">
          <ButterStick label="A pop-art stick of butter" className="w-52 sm:w-64" />
          <div>
            <Badge variant="secondary" className="mb-5">
              You&rsquo;re on the list
            </Badge>
            <h1 className="display-title m-0 max-w-2xl text-4xl leading-[1.08] text-foreground sm:text-6xl">
              Hang tight<span className="text-primary">.</span>
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-base text-muted-foreground sm:text-lg">
              You&rsquo;re signed in and saved a spot in the pantry &mdash; we&rsquo;re just letting folks in a few at a time while the shelves get stocked. Sit tight; we&rsquo;ll
              wave you through the moment your seat at the table is ready.
            </p>
            <div className="mt-8 flex items-center justify-center">
              <Button variant="outline" onClick={() => void signOutAndGoHome()}>
                Sign out
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="mt-auto">
        <div className="gingham-band" aria-hidden="true" />
        <div className="border-t-2 border-border bg-card px-4 py-8 text-muted-foreground">
          <div className="page-wrap flex flex-col items-center justify-between gap-3 text-center sm:flex-row sm:text-left">
            <p className="m-0 text-sm">&copy; {new Date().getFullYear()} Buttery — the pantry where the good stuff is kept.</p>
            <nav className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm font-semibold">
              <Link to="/terms" className="hover:text-foreground">
                Terms
              </Link>
              <Link to="/privacy" className="hover:text-foreground">
                Privacy
              </Link>
              <Link to="/ai-usage" className="hover:text-foreground">
                AI Usage
              </Link>
            </nav>
          </div>
        </div>
      </footer>
    </div>
  );
}
