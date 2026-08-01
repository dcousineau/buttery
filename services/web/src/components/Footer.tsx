import { Link } from "@tanstack/react-router";

export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-16">
      <div className="gingham-band" aria-hidden="true" />
      <div className="border-t-2 border-border bg-card px-4 pt-8 pb-12 text-muted-foreground">
        <div className="page-wrap flex flex-col items-center justify-between gap-3 text-center sm:flex-row sm:text-left">
          <p className="m-0 text-sm">&copy; {year} Buttery — the pantry where the good stuff is kept.</p>
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
            <Link to="/acknowledgements" className="hover:text-foreground">
              Acknowledgements
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
