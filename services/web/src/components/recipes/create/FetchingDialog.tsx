import { Megaphone, PencilLine, Puzzle } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "#/components/ui/dialog";
import { Button } from "#/components/ui/button";
import { Spinner } from "#/components/ui/spinner";

export type FetchPhase = "fetching" | "failed" | "rate_limited" | "no_recipe";

/**
 * The import fetch dialog (plan §B). One dialog, four phases:
 *   - fetching     → a spinner while the server scrapes.
 *   - rate_limited → a GENERIC "slow down" message. No countdown, no window —
 *     the timing is never revealed (don't hand an abuser the limit).
 *   - failed       → "That page wouldn't open up": the two ways in (bookmarklet /
 *     manual with the URL + attribution locked) plus a support report.
 *   - no_recipe    → the page opened but nothing on it reads as a recipe. The
 *     bookmarklet can't help (it ships the same page to the same parser), so
 *     only manual entry (URL locked) and the support report are offered.
 *
 * Presentational — the chooser owns the scrape call and phase state.
 */
export function FetchingDialog({
  phase,
  url,
  onManual,
  onReport,
  onClose,
  onBookmarklet,
}: {
  phase: FetchPhase | null;
  url: string;
  onManual: () => void;
  onReport: () => void;
  onClose: () => void;
  onBookmarklet: () => void;
}) {
  const open = phase != null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        {phase === "fetching" && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <Spinner className="size-7" />
            <DialogTitle>Reading the page…</DialogTitle>
            <DialogDescription className="max-w-[24rem] break-words">{url}</DialogDescription>
          </div>
        )}

        {phase === "rate_limited" && (
          <>
            <DialogTitle>One at a time</DialogTitle>
            <DialogDescription>You're going a little fast. Give it a moment, then try that import again.</DialogDescription>
            <DialogFooter className="mt-3">
              <Button onClick={onClose}>Got it</Button>
            </DialogFooter>
          </>
        )}

        {phase === "no_recipe" && (
          <>
            <div className="min-w-0">
              <DialogTitle>We couldn't find a recipe there</DialogTitle>
              <DialogDescription className="mt-1">
                The page opened, but nothing on it is marked up as a recipe we can read. Some writers share recipes as plain text in a post.
              </DialogDescription>
              <p className="mt-2 mb-0 truncate text-xs font-semibold text-muted-foreground">{url}</p>
            </div>

            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={onManual}
                className="flex items-center gap-2 rounded-lg border-2 border-border bg-card p-3 text-left text-sm font-bold transition-colors hover:bg-accent"
              >
                <PencilLine className="size-4" aria-hidden="true" />
                Enter it manually
                <span className="ml-auto text-xs font-normal text-muted-foreground">Credit stays locked to the URL</span>
              </button>
            </div>

            <DialogFooter className="mt-4 sm:justify-between">
              <Button variant="ghost" size="sm" onClick={onReport}>
                <Megaphone data-icon="inline-start" aria-hidden="true" />
                Tell Buttery about it
              </Button>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        )}

        {phase === "failed" && (
          <>
            {/* No glyph beside the title: dialog titles across the app carry no
              iconography, and a bordered box around a non-interactive alert
              icon borrowed a control's construction. The copy says it. */}
            <div className="min-w-0">
              <DialogTitle>That page wouldn't open up</DialogTitle>
              <DialogDescription className="mt-1">Some sites block anything that isn't a browser. The recipe is still gettable — here are the two ways in.</DialogDescription>
              <p className="mt-2 mb-0 truncate text-xs font-semibold text-muted-foreground">{url}</p>
            </div>

            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={onBookmarklet}
                className="flex items-center gap-2 rounded-lg border-2 border-border bg-card p-3 text-left text-sm font-bold transition-colors hover:bg-accent"
              >
                <Puzzle className="size-4" aria-hidden="true" />
                Try the bookmarklet
                <span className="ml-auto text-xs font-normal text-muted-foreground">For sites that block Buttery</span>
              </button>
              <button
                type="button"
                onClick={onManual}
                className="flex items-center gap-2 rounded-lg border-2 border-border bg-card p-3 text-left text-sm font-bold transition-colors hover:bg-accent"
              >
                <PencilLine className="size-4" aria-hidden="true" />
                Enter it manually
                <span className="ml-auto text-xs font-normal text-muted-foreground">Credit stays locked to the URL</span>
              </button>
            </div>

            <DialogFooter className="mt-4 sm:justify-between">
              <Button variant="ghost" size="sm" onClick={onReport}>
                <Megaphone data-icon="inline-start" aria-hidden="true" />
                Tell Buttery about it
              </Button>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
