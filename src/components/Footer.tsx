export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-16">
      <div className="gingham-band" aria-hidden="true" />
      <div className="border-t-2 border-border bg-card px-4 pt-8 pb-12 text-muted-foreground">
        <div className="page-wrap flex flex-col items-center justify-between gap-3 text-center sm:flex-row sm:text-left">
          <p className="m-0 text-sm">&copy; {year} Buttery — the pantry where the good stuff is kept.</p>
          <p className="m-0 text-sm font-semibold">Recipes on atproto. Yours, on your own PDS.</p>
        </div>
      </div>
    </footer>
  );
}
