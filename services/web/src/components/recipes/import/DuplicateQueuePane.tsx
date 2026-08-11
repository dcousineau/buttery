import { useEffect, useMemo, useState } from "react";
import type { ComparisonResult } from "#/lib/recipe-import/contracts.ts";
import { describeDiff, diffLines, summarizeDiff, type DiffRow } from "#/lib/recipe-import/diff.ts";
import type { ImportItem, ItemAction } from "#/lib/recipe-import/machine.ts";
import { Button } from "#/components/ui/button";
import { Progress } from "#/components/ui/progress";
import { cn } from "#/lib/utils.ts";

/**
 * "Line by line" — the maybe-duplicate queue (plan §10.1, §7.6, D21).
 *
 * A `maybe` is a fuzzy title match with *different* keys, which is exactly the case the tool
 * refuses to decide: the user is shown both copies and answers once per recipe. The queue is
 * one-at-a-time on purpose — a list of nine near-duplicates invites "select all", which is
 * the one thing this verdict must not make easy.
 *
 * Differences are shown by default and matching lines are collapsed behind a toggle, because
 * on a real duplicate 90% of the lines match and burying the three that differ is what makes
 * the comparison useless. Every differing row carries a `+`/`−` glyph as well as a fill, so
 * the comparison survives a monochrome screen and colour blindness (§10.4).
 */

const NOTHING = "— nothing —";

/** Synthetic rows for the facts that are not lines: yield, and whether a photo came along. */
function metaRows(item: ImportItem, existing: { recipeYield: string | null; hasImage: boolean } | null): DiffRow[] {
  const rows: DiffRow[] = [];
  const mineYield = existing?.recipeYield ?? null;
  const theirsYield = item.record.recipeYield ?? null;
  if (mineYield || theirsYield) {
    const same = (mineYield ?? "") === (theirsYield ?? "");
    rows.push({ status: same ? "same" : "added", text: theirsYield ?? NOTHING, marker: same ? " " : "+" });
    if (!same) rows.push({ status: "removed", text: mineYield ?? NOTHING, marker: "−" });
  }
  return rows;
}

/** Left/right cells for one unified diff row. `removed` is yours only, `added` is theirs only. */
function cells(row: DiffRow): { mine: string; theirs: string } {
  if (row.status === "same") return { mine: row.text, theirs: row.text };
  if (row.status === "removed") return { mine: row.text, theirs: NOTHING };
  return { mine: NOTHING, theirs: row.text };
}

export function DuplicateQueuePane({
  item,
  position,
  total,
  isLast,
  importerLabel,
  comparisons,
  nextName,
  onDecide,
}: {
  item: ImportItem;
  position: number;
  total: number;
  isLast: boolean;
  importerLabel: string;
  comparisons: { entries: ComparisonResult; loading: boolean; error: string | null; load: (ids: readonly string[]) => void };
  nextName: string | null;
  onDecide: (action: ItemAction) => void;
}) {
  // "Show the matching lines" is a decision about the recipe in front of you, not a
  // preference, so it starts collapsed on every card. The reset is a `key` on this component
  // in `ImportReviewScreen` — a remount per clientId — rather than an effect that sets state
  // after the wrong card has already painted.
  const [showMatches, setShowMatches] = useState(false);
  const recipeId = item.existing?.recipeId ?? null;

  // §7.6 is fetched on demand, one comparison at a time — the store de-duplicates, so this
  // runs on every render of every queue card without a second round trip.
  useEffect(() => {
    if (recipeId) comparisons.load([recipeId]);
  }, [comparisons, recipeId]);

  const existing = recipeId ? (comparisons.entries[recipeId] ?? null) : null;

  const rows = useMemo(() => {
    if (!existing) return [];
    return [...metaRows(item, existing), ...diffLines(existing.ingredients, item.record.ingredients), ...diffLines(existing.instructions, item.record.instructions)];
  }, [existing, item]);

  const differing = rows.filter((row) => row.status !== "same");
  const matching = rows.filter((row) => row.status === "same");
  const summary = summarizeDiff(rows);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-4 border-b-2 border-border px-5 py-3.5">
        <div>
          <h2 className="display-title m-0 text-xl/[1.15]">Line by line</h2>
          <p className="m-0 mt-0.5 text-[0.8125rem] text-muted-foreground">Same title, different keys — Buttery won't guess. Differences only; matching lines are hidden.</p>
        </div>
        <div className="ml-auto flex w-52 flex-none flex-col gap-1.5">
          <div className="flex items-baseline gap-1.5 text-[0.8125rem] text-muted-foreground">
            <span className="font-semibold text-foreground">
              {position} of {total}
            </span>
            <span className="ml-auto">{total - position} left</span>
          </div>
          <Progress
            value={position}
            max={total}
            label={`${position} of ${total} looked at`}
            aria-label="Duplicates looked at"
            variant="secondary"
            className="h-3 rounded-lg border-2 border-border bg-background"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex border-b-2 border-border bg-card text-xs font-semibold text-muted-foreground">
          <div className="flex-1 border-r-2 border-border px-4 py-2">Yours · {existing?.name ?? "…"}</div>
          <div className="flex-1 px-4 py-2">
            {importerLabel} · {item.record.name}
          </div>
        </div>

        {/* A comparison that cannot be fetched is not a failed import: the user can still
            decide, they just decide without the side-by-side (§10.3). */}
        {!existing ? (
          <p className="m-0 px-4 py-4 text-sm text-muted-foreground">
            {comparisons.error
              ? `Your copy couldn't be loaded (${comparisons.error}). You can still choose below.`
              : comparisons.loading
                ? "Loading the copy in your box…"
                : "Your copy isn't available to show. You can still choose below."}
          </p>
        ) : null}

        {differing.map((row, i) => {
          const cell = cells(row);
          return (
            <div key={`d${i}`} className="flex border-b border-border/60 text-sm">
              <div className={cn("flex-1 border-r-2 border-border px-4 py-2", cell.mine === NOTHING && "text-muted-foreground")}>
                <span aria-hidden="true" className="mr-1.5 font-bold">
                  {row.status === "removed" ? "−" : " "}
                </span>
                {cell.mine}
              </div>
              <div className={cn("flex-1 px-4 py-2", row.status === "added" && "bg-secondary text-secondary-foreground", cell.theirs === NOTHING && "text-muted-foreground")}>
                <span aria-hidden="true" className="mr-1.5 font-bold">
                  {row.status === "added" ? "+" : " "}
                </span>
                {cell.theirs}
              </div>
            </div>
          );
        })}

        {matching.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowMatches((v) => !v)}
            aria-expanded={showMatches}
            className="block w-full border-b border-border/60 bg-card px-4 py-2.5 text-left text-[0.8125rem] font-semibold text-muted-foreground hover:bg-accent focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-ring"
          >
            {showMatches ? `Hide the ${matching.length} lines that match exactly` : `${matching.length} more lines match exactly — show them`}
          </button>
        ) : null}

        {showMatches
          ? matching.map((row, i) => (
              <div key={`s${i}`} className="flex border-b border-border/60 text-sm text-muted-foreground">
                <div className="flex-1 border-r-2 border-border px-4 py-2">{row.text}</div>
                <div className="flex-1 px-4 py-2">{row.text}</div>
              </div>
            ))
          : null}
      </div>

      {/* The one description a screen-reader user gets instead of scanning two columns. */}
      <p className="sr-only" aria-live="polite">
        {existing ? describeDiff(summary, `${item.record.name} compared with your copy`) : ""}
      </p>

      <div className="flex flex-none items-center gap-3 border-t-2 border-border bg-card px-5 py-2.5">
        <Button variant="outline" onClick={() => onDecide("skip")}>
          Skip · next
        </Button>
        <div className="ml-auto text-[0.8125rem] text-muted-foreground">{nextName ? `Next up: ${nextName}` : "Last one"}</div>
        <Button variant="secondary" onClick={() => onDecide("import")}>
          {isLast ? "Import · done with duplicates" : "Import · next"}
        </Button>
      </div>
    </div>
  );
}
