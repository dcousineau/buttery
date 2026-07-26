import { Link } from "@tanstack/react-router";
import ButterStick from "./ButterStick";
import ThemeToggle from "./ThemeToggle";
import { Badge } from "#/components/ui/badge";

/**
 * Production soft-launch holding page. Shown in place of the whole app shell
 * while `COMING_SOON=true` (see `src/lib/config.ts`) — no sidebar, no header
 * auth, no login or recipe UI. Hidden in local dev, where the real app renders.
 */
export default function ComingSoon() {
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
              A social recipe box on the open web
            </Badge>
            <h1 className="display-title m-0 max-w-2xl text-4xl leading-[1.08] text-foreground sm:text-6xl">
              Coming soon<span className="text-primary">.</span>
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-base text-muted-foreground sm:text-lg">
              <strong className="text-foreground">but·ter·y</strong> <em>(noun)</em> — a pantry; a room where the good stuff is kept. We&rsquo;re getting the shelves stocked. Check
              back soon.
            </p>
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
