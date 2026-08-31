import { Compass, X } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Spinner } from "#/components/ui/spinner";

/**
 * The empty-pool state (§5.4, §4.3, §4.5). Rendered in TWO different places
 * depending on when it happens — before the first roll it fills the result
 * region; if a filter change empties the pool out from under an on-screen
 * result, it renders in the controls region instead while the stale result
 * stays put below (§5.6) — but it is the same component either way, so the
 * copy and behaviour cannot drift between the two placements.
 *
 * The §4.3 coverage line is deliberately confined to THIS component — the
 * always-visible pool line never turns into a coverage report (§4.3, §12).
 */
export function RandomizerEmptyState({
  source,
  totalInScope,
  unenrichedInScope,
  widening,
  onClear,
  onWiden,
}: {
  /**
   * Which scope emptied. It decides two things that were previously a derived
   * boolean and a wrong possessive: widening is offered only from `"box"`
   * (§4.5 — a corpus pool has nowhere further to widen to), and the coverage
   * line only gets to say "your" about recipes that are actually yours.
   */
  source: "box" | "corpus";
  totalInScope: number;
  unenrichedInScope: number;
  widening: boolean;
  onClear: () => void;
  onWiden: () => void;
}) {
  const canWiden = source === "box";
  // Built as one string rather than interleaved JSX expressions: the box and
  // corpus wordings differ by a possessive AND an adjective, and JSX whitespace
  // between adjacent expressions leaves a double space in whichever branch
  // renders the empty one.
  const coverage = canWiden
    ? `${unenrichedInScope} of your ${totalInScope} ${totalInScope === 1 ? "recipe is" : "recipes are"} still being tagged, so a diet or meal-type filter can't see ${unenrichedInScope === 1 ? "it" : "them"} yet.`
    : `${unenrichedInScope} of the ${totalInScope} public ${totalInScope === 1 ? "recipe here is" : "recipes here are"} still being tagged, so a diet or meal-type filter can't see ${unenrichedInScope === 1 ? "it" : "them"} yet.`;
  return (
    <div className="flex flex-col items-start gap-2.5 rounded-lg border-2 border-border bg-card p-4 shadow-pop-sm">
      <p className="m-0 text-sm font-semibold text-foreground">No recipes match these filters</p>
      {unenrichedInScope > 0 && <p className="m-0 text-[0.8125rem] text-muted-foreground">{coverage}</p>}
      <Button variant="outline" size="sm" onClick={onClear}>
        <X data-icon="inline-start" aria-hidden="true" />
        Clear filters
      </Button>

      {canWiden && (
        <div className="mt-1 flex flex-col items-start gap-1.5 border-t-2 border-border/45 pt-2.5">
          <Button size="sm" disabled={widening} onClick={onWiden}>
            {widening ? <Spinner /> : <Compass data-icon="inline-start" aria-hidden="true" />}
            {widening ? "Looking…" : "Look in public recipes"}
          </Button>
          <p className="m-0 text-[0.75rem] text-muted-foreground">Widening looks outside your box, at public recipes on the network you haven't kept yet.</p>
        </div>
      )}
    </div>
  );
}
