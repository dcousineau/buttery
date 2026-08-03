import { CircleAlert, Link2, PencilLine, Puzzle } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "#/components/ui/dialog";
import { Button } from "#/components/ui/button";
import { Spinner } from "#/components/ui/spinner";

export type FetchPhase = "fetching" | "failed" | "rate_limited";

/**
 * The import fetch dialog (plan §B). One dialog, three phases:
 *   - fetching     → a spinner while the server scrapes.
 *   - rate_limited → a GENERIC "slow down" message. No countdown, no window —
 *     the timing is never revealed (don't hand an abuser the limit).
 *   - failed       → "That page wouldn't open up": the two ways in (bookmarklet /
 *     manual with the URL + attribution locked) plus a support report.
 *
 * Presentational — the chooser owns the scrape call and phase state.
 */
export function FetchingDialog({
  phase,
  url,
  onManual,
  onReport,
  onClose,
}: {
  phase: FetchPhase | null;
  url: string;
  onManual: () => void;
  onReport: () => void;
  onClose: () => void;
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

        {phase === "failed" && (
          <>
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid size-8 shrink-0 place-content-center rounded-md border-2 border-border bg-background text-destructive">
                <CircleAlert className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <DialogTitle>That page wouldn't open up</DialogTitle>
                <DialogDescription className="mt-1">Some sites block anything that isn't a browser. The recipe is still gettable — here are the two ways in.</DialogDescription>
                <p className="mt-2 mb-0 truncate text-xs font-semibold text-muted-foreground">{url}</p>
              </div>
            </div>

            <div className="mt-4 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3 rounded-lg border-2 border-border bg-card p-3 opacity-60">
                <span className="flex items-center gap-2 text-sm font-bold">
                  <Puzzle className="size-4" aria-hidden="true" />
                  Try the bookmarklet
                </span>
                <span className="rounded-4xl border-2 border-border px-1.5 text-[0.6rem] font-semibold tracking-wide uppercase text-muted-foreground">soon</span>
              </div>
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
                <Link2 data-icon="inline-start" aria-hidden="true" />
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
