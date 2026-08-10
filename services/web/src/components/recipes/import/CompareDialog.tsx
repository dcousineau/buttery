import { useEffect, useMemo } from "react";
import type { ComparisonResult } from "#/lib/recipe-import/contracts.ts";
import { describeDiff, diffLines, summarizeDiff } from "#/lib/recipe-import/diff.ts";
import type { ImportItem } from "#/lib/recipe-import/machine.ts";
import { Button } from "#/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "#/components/ui/dialog";
import { cn } from "#/lib/utils.ts";

/**
 * "Same recipe?" — the side-by-side overlay (plan §7.6, §10.1).
 *
 * The queue is where nine flagged recipes get worked through; this is the same comparison
 * reachable from any single row, so a user who notices something odd in "Ready to import" can
 * check it without leaving the list. Both sides are already in the browser, so the diff is
 * local (§7.6 explicitly has no server-side diff and no match score).
 *
 * Differing lines carry a `+`/`−` glyph as well as a butter fill — §10.4 forbids colour as
 * the only cue — and the whole comparison is summarized in one sentence in a live region for
 * anyone not reading two columns.
 */
export function CompareDialog({
  item,
  importerLabel,
  comparisons,
  onSkip,
  onImportAnyway,
  onClose,
}: {
  item: ImportItem | null;
  importerLabel: string;
  comparisons: { entries: ComparisonResult; loading: boolean; error: string | null; load: (ids: readonly string[]) => void };
  onSkip: () => void;
  onImportAnyway: () => void;
  onClose: () => void;
}) {
  const recipeId = item?.existing?.recipeId ?? null;

  useEffect(() => {
    if (recipeId) comparisons.load([recipeId]);
  }, [comparisons, recipeId]);

  const existing = recipeId ? (comparisons.entries[recipeId] ?? null) : null;

  const rows = useMemo(() => {
    if (!item || !existing) return { ingredients: [], instructions: [] };
    return { ingredients: diffLines(existing.ingredients, item.record.ingredients), instructions: diffLines(existing.instructions, item.record.instructions) };
  }, [existing, item]);

  const summary = summarizeDiff([...rows.ingredients, ...rows.instructions]);

  return (
    <Dialog open={item !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {/* `gap-0` on top of `p-0`: the popup's default `gap-5` spaces a padded dialog's stacked
          blocks, but this one is full-bleed — its own rules and borders do the separating, and
          the inherited gap only pushes the header rule away from the columns under it. */}
      <DialogContent size="xl" className="max-h-[calc(100svh-4rem)] gap-0 overflow-auto p-0">
        <div className="flex flex-none items-center gap-3 border-b-2 border-border bg-card px-5 py-3">
          <DialogTitle size="lg">Same recipe?</DialogTitle>
          <div className="ml-auto" />
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close the comparison">
            <span aria-hidden="true">×</span>
          </Button>
        </div>

        <DialogDescription className="sr-only">
          {item && existing ? describeDiff(summary, `${item.record.name} compared with your copy`) : "Loading the recipe in your box."}
        </DialogDescription>

        {item ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-auto sm:flex-row">
            <section aria-label="In your box" className="flex min-w-0 flex-1 flex-col border-b-2 border-border sm:border-r-2 sm:border-b-0">
              <div className="border-b-2 border-border bg-card px-4 py-2.5">
                <div className="text-[0.9375rem] font-semibold">In your box</div>
                <div className="text-xs text-muted-foreground">
                  {existing ? [existing.addedAt ? `added ${new Date(existing.addedAt).toLocaleDateString()}` : null, existing.addedByHandle].filter(Boolean).join(" · ") : "…"}
                </div>
              </div>
              <div className="flex flex-col gap-2 p-4">
                <div className="display-title text-[1.0625rem]">{existing?.name ?? (comparisons.loading ? "Loading…" : "Not available")}</div>
                <div className="text-[0.8125rem] text-muted-foreground">
                  {existing
                    ? [existing.recipeYield, existing.hasImage ? "photo" : "no photo", `${existing.ingredients.length} ingredients`, `${existing.instructions.length} steps`]
                        .filter(Boolean)
                        .join(" · ")
                    : ""}
                </div>
                <Side rows={rows.ingredients} side="mine" />
                <Side rows={rows.instructions} side="mine" />
              </div>
            </section>

            <section aria-label={`From ${importerLabel}`} className="flex min-w-0 flex-1 flex-col bg-card">
              <div className="border-b-2 border-border px-4 py-2.5">
                <div className="text-[0.9375rem] font-semibold">From {importerLabel}</div>
                <div className="text-xs text-muted-foreground">{item.entryName}</div>
              </div>
              <div className="flex flex-col gap-2 p-4">
                <div className="display-title text-[1.0625rem]">{item.record.name}</div>
                <div className="text-[0.8125rem] text-muted-foreground">
                  {[item.record.recipeYield, item.imageUrl ? "photo" : "no photo", `${item.record.ingredients.length} ingredients`, `${item.record.instructions.length} steps`]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                <Side rows={rows.ingredients} side="theirs" />
                <Side rows={rows.instructions} side="theirs" />
              </div>
            </section>
          </div>
        ) : null}

        <div className="flex flex-none flex-wrap items-center gap-3 border-t-2 border-border bg-card px-5 py-3">
          <div className="text-xs text-muted-foreground">
            {summary.identical ? "Every line matches." : `Butter marks the lines that differ — ${summary.added} only here, ${summary.removed} only in your box.`}
          </div>
          <div className="ml-auto" />
          <Button variant="outline" onClick={onSkip}>
            Skip the imported one
          </Button>
          <Button variant="secondary" onClick={onImportAnyway}>
            Import it anyway
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One column of a comparison: the lines that side actually has, marked where they differ. */
function Side({ rows, side }: { rows: ReturnType<typeof diffLines>; side: "mine" | "theirs" }) {
  const visible = rows.filter((row) => (side === "mine" ? row.status !== "added" : row.status !== "removed"));
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {visible.map((row, i) => {
        const differs = row.status !== "same";
        return (
          <div key={i} className={cn("rounded-md px-1.5 py-0.5 text-[0.8125rem]/[1.5]", differs && "bg-secondary text-secondary-foreground")}>
            <span aria-hidden="true" className="mr-1.5 font-bold">
              {differs ? row.marker : " "}
            </span>
            {row.text}
          </div>
        );
      })}
    </div>
  );
}
