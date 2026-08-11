import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BookOpenText, Boxes, Link2, PencilLine, Puzzle } from "lucide-react";
import { useAnalytics } from "#/lib/analytics";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "#/components/ui/dialog";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Spinner } from "#/components/ui/spinner";
import { cn } from "#/lib/utils";
import { scrapeRecipe } from "#/server/recipe-scrape";
import { useRecipesView } from "../context";
import { FetchingDialog, type FetchPhase } from "./FetchingDialog";
import { BookmarkletInstallDialog } from "./BookmarkletInstallDialog";

type Choice = "import" | "manual" | "bookmarklet" | "library";

/**
 * The single "Add a recipe" entry point (plan §A4). Offers the three create paths
 * plus a demoted "Add an existing recipe" branch that opens the GlobalRecipePicker.
 * The create paths navigate to the full-page form (`/household/recipes/new`);
 * "Import from a URL" carries the source URL so the form locks Website attribution
 * to it. Server-side scrape + bookmarklet are Phase B/C — the bookmarklet option
 * is shown but disabled here.
 */
export function AddRecipeChooser({ open, onOpenChange, onAddExisting }: { open: boolean; onOpenChange: (o: boolean) => void; onAddExisting: () => void }) {
  const navigate = useNavigate();
  const { posthog } = useAnalytics();
  const { pushToast } = useRecipesView();
  const [choice, setChoice] = useState<Choice>("manual");
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);

  // Import fetch phase (spinner / rate-limited / failed) + the URL that failed
  // (for the manual fallback → attribution stays locked to it).
  const [phase, setPhase] = useState<FetchPhase | null>(null);
  const [failUrl, setFailUrl] = useState("");
  const [installOpen, setInstallOpen] = useState(false);
  const fetching = phase === "fetching";

  function goManual() {
    onOpenChange(false);
    void navigate({ to: "/household/recipes/new" });
  }

  function goLibrary() {
    onOpenChange(false);
    void navigate({ to: "/household/recipes/import" });
  }

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
        onOpenChange(false);
        void navigate({ to: "/household/recipes/new", search: { import: res.importId } });
        return;
      }
      if (res.status === "rate_limited") return setPhase("rate_limited");
      if (res.status === "invalid_url") {
        setPhase(null);
        setUrlError("That doesn't look like a recipe link.");
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
    onOpenChange(false);
    void navigate({ to: "/household/recipes/new", search: { source: failUrl } });
  }

  function reportFailure() {
    posthog.capture("recipe_import_failed_report", { url: failUrl });
    setPhase(null);
    pushToast("Thanks — we'll take a look at that site.");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogTitle>Add a recipe</DialogTitle>
        <DialogDescription>Bring one in from the web, or write it out yourself.</DialogDescription>

        <div className="mt-2 flex flex-col gap-2">
          <Option
            selected={choice === "import"}
            onSelect={() => setChoice("import")}
            icon={<Link2 className="size-4" aria-hidden="true" />}
            title="Import from a URL"
            description="Paste a recipe link and Buttery reads the page."
          >
            {choice === "import" && (
              <div className="mt-2 flex flex-col gap-1.5">
                <div className="flex gap-2">
                  <Input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && goImport()}
                    placeholder="https://smittenkitchen.com/…"
                    aria-label="Recipe URL"
                    disabled={fetching}
                  />
                  <Button onClick={goImport} disabled={!url.trim() || fetching}>
                    {fetching ? <Spinner data-icon="inline-start" /> : null}
                    Fetch
                  </Button>
                </div>
                {urlError && <p className="m-0 text-xs font-semibold text-destructive">{urlError}</p>}
              </div>
            )}
          </Option>

          <Option
            selected={choice === "manual"}
            onSelect={() => setChoice("manual")}
            icon={<PencilLine className="size-4" aria-hidden="true" />}
            title="Enter it manually"
            description="The empty form. You pick the attribution."
          >
            {choice === "manual" && (
              <div className="mt-2">
                <Button onClick={goManual}>
                  <BookOpenText data-icon="inline-start" aria-hidden="true" />
                  Start a blank recipe
                </Button>
              </div>
            )}
          </Option>

          <Option
            selected={choice === "bookmarklet"}
            onSelect={() => setChoice("bookmarklet")}
            icon={<Puzzle className="size-4" aria-hidden="true" />}
            title="Use the bookmarklet"
            description="For sites that won't let Buttery read them."
          >
            {choice === "bookmarklet" && (
              <div className="mt-2">
                <Button onClick={() => setInstallOpen(true)}>
                  <Puzzle data-icon="inline-start" aria-hidden="true" />
                  Get the bookmarklet
                </Button>
              </div>
            )}
          </Option>

          {/* Bulk import (plan §9). Deliberately named by what the user has — a recipe box —
              rather than by the app that wrote it: the route resolves the importer itself, and
              naming one here would put an importer's name in a component, which is the thing
              §2.5 exists to prevent. */}
          <Option
            selected={choice === "library"}
            onSelect={() => setChoice("library")}
            icon={<Boxes className="size-4" aria-hidden="true" />}
            title="Bring in your recipe box"
            description="Move a whole library over from another recipe app."
          >
            {choice === "library" && (
              <div className="mt-2">
                <Button onClick={goLibrary}>
                  <Boxes data-icon="inline-start" aria-hidden="true" />
                  Start an import
                </Button>
              </div>
            )}
          </Option>
        </div>

        <DialogFooter className="mt-2 sm:justify-between">
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              onAddExisting();
            }}
          >
            Add an existing recipe
          </Button>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        </DialogFooter>
      </DialogContent>

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
    </Dialog>
  );
}

function Option({
  selected,
  onSelect,
  icon,
  title,
  description,
  soon,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
  soon?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-lg border-2 border-border bg-card p-3 transition-colors", selected && !soon && "bg-accent shadow-(--shadow-pop-sm)", soon && "opacity-60")}>
      <button type="button" disabled={soon} aria-pressed={selected} onClick={onSelect} className="flex w-full items-start gap-3 text-left outline-none disabled:cursor-not-allowed">
        <span className="mt-0.5 grid size-8 shrink-0 place-content-center rounded-md border-2 border-border bg-background text-foreground">{icon}</span>
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2 text-[0.9375rem] font-bold text-foreground">
            {title}
            {soon && <span className="rounded-4xl border-2 border-border px-1.5 text-[0.6rem] font-semibold tracking-wide uppercase text-muted-foreground">soon</span>}
          </span>
          <span className="text-[0.8125rem] text-muted-foreground">{description}</span>
        </span>
      </button>
      {children}
    </div>
  );
}
