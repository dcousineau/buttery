import { useState } from "react";
import { AlarmClock, ListChecks, Timer as TimerIcon, X } from "lucide-react";
import { remainingMs, useRecipeTimers } from "#/lib/timers/store";
import { formatRemaining } from "#/components/timers/TimerRow";
import { cn } from "#/lib/utils";
import { TimersPanel } from "./TimersPanel";

type Panel = "ingredients" | "timers";

/**
 * The narrow-screen cook-phase dock (plan §4.3, issue #12). Replaces the old
 * stacked full-height ingredient accordion + timers panel — which ate most of a
 * phone screen while cooking — with a single compact row of two triggers that
 * open bottom-sheet modals on demand. The **timers** trigger stays collapsed by
 * default and previews the timer closest to finishing (its label, remaining, and
 * a live progress bar), so the running state is legible without opening anything.
 * md+ keeps the always-visible left rail; this whole surface is `md:hidden`.
 */
export function MobileCookDock({ recipeId, ingredients }: { recipeId: string; ingredients: string[] }) {
  const [open, setOpen] = useState<Panel | null>(null);
  const timers = useRecipeTimers(recipeId);

  const alarming = timers.filter((t) => t.status === "alarming").length;
  // The non-alarming timer nearest completion drives the collapsed preview.
  const lead = timers
    .filter((t) => t.status !== "alarming")
    .reduce<{ label: string; remaining: number; progress: number } | null>((best, t) => {
      const remaining = remainingMs(t);
      if (best && remaining >= best.remaining) return best;
      const progress = t.totalMs > 0 ? Math.min(1, Math.max(0, 1 - remaining / t.totalMs)) : 0;
      return { label: t.label, remaining, progress };
    }, null);

  const timersSummary = alarming > 0 ? `${alarming} done` : lead ? `${formatRemaining(lead.remaining)} left` : "none yet";

  return (
    <>
      <div className="grid grid-cols-2 gap-2 md:hidden">
        {/* Ingredients trigger */}
        <button
          type="button"
          onClick={() => setOpen("ingredients")}
          aria-haspopup="dialog"
          className="flex items-center gap-2 rounded-xl border-2 border-border bg-card/60 px-3.5 py-2.5 text-left font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ListChecks className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate">Ingredients</span>
          <span className="ml-auto shrink-0 text-sm font-normal text-muted-foreground">{ingredients.length}</span>
        </button>

        {/* Timers trigger — collapsed preview of the timer closest to finishing. */}
        <button
          type="button"
          onClick={() => setOpen("timers")}
          aria-haspopup="dialog"
          aria-label={`Timers, ${timersSummary}`}
          className={cn(
            "flex flex-col gap-1.5 rounded-xl border-2 bg-card/60 px-3.5 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
            alarming > 0 ? "border-destructive bg-destructive/10" : "border-border",
          )}
        >
          <span className="flex items-center gap-2 font-semibold text-foreground">
            {alarming > 0 ? (
              <AlarmClock className="size-4 shrink-0 text-destructive" aria-hidden="true" />
            ) : (
              <TimerIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="truncate">{alarming > 0 ? "Time!" : lead ? lead.label : "Timers"}</span>
            <span className={cn("ml-auto shrink-0 text-sm font-normal tabular-nums", alarming > 0 ? "font-semibold text-destructive" : "text-muted-foreground")}>
              {timersSummary}
            </span>
          </span>
          {/* Progress of the nearest-completing timer (hidden bar keeps height stable). */}
          <span className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            {lead && alarming === 0 && <span className="block h-full rounded-full bg-secondary transition-[width] duration-500" style={{ width: `${lead.progress * 100}%` }} />}
          </span>
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 z-40 flex flex-col justify-end md:hidden">
          <button type="button" aria-label="Close" onClick={() => setOpen(null)} className="absolute inset-0 bg-background/70 backdrop-blur-sm" />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={open === "ingredients" ? "Ingredients" : "Timers"}
            className="relative max-h-[75vh] overflow-y-auto rounded-t-2xl border-t-2 border-border bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] shadow-pop-md"
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="display-title m-0 text-base text-foreground">{open === "ingredients" ? "Ingredients" : "Timers"}</h2>
              <button
                type="button"
                onClick={() => setOpen(null)}
                aria-label="Close"
                className="grid size-8 place-content-center rounded-lg text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            {open === "ingredients" ? (
              ingredients.length === 0 ? (
                <p className="m-0 text-sm text-muted-foreground">No ingredients listed.</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {ingredients.map((line, i) => (
                    <li key={i} className="flex gap-2 text-base leading-snug text-foreground">
                      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <TimersPanel recipeId={recipeId} />
            )}
          </div>
        </div>
      )}
    </>
  );
}
