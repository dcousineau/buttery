import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Compass, Link2, Pencil } from "lucide-react";
import { useAnalytics } from "#/lib/analytics";
import { cn } from "#/lib/utils";
import { scrapeRecipe } from "#/server/recipe-scrape";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Spinner } from "#/components/ui/spinner";
import { BookmarkletInstallDialog } from "#/components/recipes/create/BookmarkletInstallDialog";
import { FetchingDialog, type FetchPhase } from "#/components/recipes/create/FetchingDialog";

/**
 * The fresh-household "Fill the box" card — the whole reason `/household` has an
 * empty state. Four tiles, each a deep link into a flow that already exists:
 * the bulk importer, the URL scrape, the blank form, and the network browser.
 *
 * The URL tile is deliberately NOT a second implementation of the import: it
 * calls the same `scrapeRecipe` server fn as `AddRecipeChooser` and hands the
 * result to the same `FetchingDialog`, so the fetching / rate-limited / blocked
 * paths (and the manual fallback that keeps Website attribution locked to the
 * source URL) behave identically in both places.
 *
 * Presentational apart from that one call — the route owns the toast surface and
 * gets the success message through `onNotify`.
 */
export function FillTheBoxCard({ onNotify, className }: { onNotify?: (message: string) => void; className?: string }) {
  const navigate = useNavigate();
  const { posthog } = useAnalytics();
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);

  // Import fetch phase (spinner / rate-limited / failed) + the URL that failed
  // (for the manual fallback → attribution stays locked to it).
  const [phase, setPhase] = useState<FetchPhase | null>(null);
  const [failUrl, setFailUrl] = useState("");
  const [installOpen, setInstallOpen] = useState(false);
  const fetching = phase === "fetching";

  async function goImport() {
    const trimmed = url.trim();
    if (!trimmed || fetching) return;
    setUrlError(null);
    setFailUrl(trimmed);
    setPhase("fetching");
    try {
      const res = await scrapeRecipe({ data: { url: trimmed } });
      // Reached the page (full or partial) → open the form prefilled by import id.
      if (res.status === "ok" || res.status === "partial") {
        setPhase(null);
        navigate({ to: "/household/recipes/new", search: { import: res.importId } });
        return;
      }
      if (res.status === "rate_limited") return setPhase("rate_limited");
      if (res.status === "invalid_url") {
        setPhase(null);
        setUrlError("That doesn’t look like a recipe link.");
        return;
      }
      // blocked / fetch_failed → the "wouldn't open up" fallback frame.
      setPhase("failed");
    } catch {
      setPhase("failed");
    }
  }

  // Failure fallback: go to the manual form with the URL, so Website attribution
  // stays locked to the source even though we couldn't read the page.
  function goManualFromFailure() {
    setPhase(null);
    navigate({ to: "/household/recipes/new", search: { source: failUrl } });
  }

  function reportFailure() {
    posthog.capture("recipe_import_failed_report", { url: failUrl });
    setPhase(null);
    onNotify?.("Thanks — we’ll take a look at that site.");
  }

  return (
    <Card size="lg" className={className}>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="display-title text-2xl leading-[1.1]">
          Fill the box
        </CardTitle>
        <CardDescription>
          Bring the recipes you already cook — in bulk from another app, or one at a time — and the planner, the shopping list and cook mode all have something to work with.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        <section className="flex flex-col gap-3">
          <div className="flex items-baseline gap-2">
            <h3 className={SECTION_LABEL}>Import from another app</h3>
            <span className="text-[0.8125rem] text-muted-foreground">More services soon.</span>
          </div>
          <div className={TILE_GRID}>
            <Tile
              icon={
                /* The real third-party mark, not a Lucide glyph — given the system's
                   border + small radius but never tinted or recoloured. Decorative:
                   the label beside it already names the app. */
                <img
                  src="/third-party/paprika/paprika-icon.png"
                  alt=""
                  aria-hidden="true"
                  className="size-5 flex-none rounded-[min(var(--radius-md),6px)] border-2 border-border"
                />
              }
              title="Import from Paprika 3"
              body="Point Buttery at your Paprika account and it brings the whole box over — photos, notes and ratings included."
            >
              <div>
                <Button variant="outline" render={<Link to="/household/recipes/import" />} nativeButton={false}>
                  Import from Paprika 3
                </Button>
              </div>
            </Tile>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className={SECTION_LABEL}>Or add them one at a time</h3>
          <div className={TILE_GRID}>
            <Tile
              icon={<Link2 className="size-5 flex-none" aria-hidden="true" />}
              title="Paste a recipe link"
              body="Any recipe page on the web. Buttery reads the ingredients and steps."
            >
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <Input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && goImport()}
                    placeholder="https://…"
                    aria-label="Recipe URL"
                    aria-invalid={urlError != null || undefined}
                    disabled={fetching}
                    className="min-w-0 flex-1"
                  />
                  <Button variant="outline" onClick={goImport} disabled={!url.trim() || fetching}>
                    {fetching ? <Spinner data-icon="inline-start" /> : null}
                    Fetch
                  </Button>
                </div>
                {urlError && (
                  <p role="alert" className="m-0 text-xs font-semibold text-destructive">
                    {urlError}
                  </p>
                )}
              </div>
            </Tile>

            <Tile
              icon={<Pencil className="size-5 flex-none" aria-hidden="true" />}
              title="Type one in by hand"
              body="The one on the index card, in your grandmother’s handwriting."
            >
              <div>
                <Button variant="outline" render={<Link to="/household/recipes/new" />} nativeButton={false}>
                  Write a recipe
                </Button>
              </div>
            </Tile>

            <Tile
              icon={<Compass className="size-5 flex-none" aria-hidden="true" />}
              title="Browse the network"
              body="Recipes other people have published to atproto. Save any of them to your box."
            >
              <div>
                <Button variant="outline" render={<Link to="/household/recipes" />} nativeButton={false}>
                  Browse recipes
                </Button>
              </div>
            </Tile>
          </div>
        </section>
      </CardContent>

      <FetchingDialog
        phase={phase}
        url={failUrl}
        onManual={goManualFromFailure}
        onReport={reportFailure}
        onClose={() => setPhase(null)}
        onBookmarklet={() => {
          setPhase(null);
          setInstallOpen(true);
        }}
      />
      <BookmarkletInstallDialog open={installOpen} onOpenChange={setInstallOpen} />
    </Card>
  );
}

/** The eyebrow above each group of tiles. */
const SECTION_LABEL = "m-0 text-[0.8125rem] font-bold tracking-[0.06em] text-muted-foreground uppercase";

/** Tiles reflow on their own — the card is laid out in the page, not in a breakpoint. */
const TILE_GRID = "grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-4";

function Tile({ icon, title, body, children, className }: { icon: React.ReactNode; title: string; body: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 rounded-xl border-2 border-border bg-card p-4 shadow-pop-sm", className)}>
      <h4 className="m-0 flex items-center gap-2 text-sm leading-snug font-semibold text-foreground">
        {icon}
        {title}
      </h4>
      <p className="m-0 text-[0.8125rem] text-pretty text-muted-foreground">{body}</p>
      {children}
    </div>
  );
}
