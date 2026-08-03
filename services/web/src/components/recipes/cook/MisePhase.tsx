import { Minus, Plus } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Switch } from "#/components/ui/switch";
import { cn } from "#/lib/utils";

/**
 * Mise en place — the large scaled ingredient checklist with prep progress and
 * de-emphasized scale/unit controls (plan §4.2, §8). Checked rows dim with a gold
 * (butter) border, no strikethrough. "Start cooking" arms audio and advances to
 * the focus-scroll cook phase.
 */
export function MisePhase({
  title,
  ingredients,
  serves,
  prepped,
  onTogglePrep,
  factor,
  metric,
  onFactor,
  onMetric,
  onStart,
}: {
  title: string;
  ingredients: string[];
  serves: number | null;
  prepped: number[];
  onTogglePrep: (index: number) => void;
  factor: number;
  metric: boolean;
  onFactor: (n: number) => void;
  onMetric: (b: boolean) => void;
  onStart: () => void;
}) {
  const preppedSet = new Set(prepped);
  const doneCount = ingredients.reduce((n, _line, i) => n + (preppedSet.has(i) ? 1 : 0), 0);

  return (
    <div className="flex h-full flex-col">
      {/* Scrolling content. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pb-6">
          <div className="flex flex-col gap-2">
            <p className="text-sm font-bold tracking-wide text-muted-foreground uppercase">Mise en place</p>
            <h1 className="display-title m-0 text-[clamp(1.75rem,4vw,3rem)] leading-[1.08] text-balance text-foreground">{title}</h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
              {serves != null && <span className="font-semibold">Serves {serves}</span>}
              <span aria-live="polite" className="font-semibold text-foreground">
                {doneCount} of {ingredients.length} prepped
              </span>
            </div>

            {/* De-emphasized scale/unit controls — write back through the shared context. */}
            <div className="mt-1 flex flex-wrap items-center gap-3 text-sm">
              <div className="inline-flex items-center gap-2 rounded-lg border-2 border-border bg-card/60 px-2 py-1">
                <button
                  type="button"
                  onClick={() => onFactor(Math.max(0.5, Math.round((factor - 0.5) * 2) / 2))}
                  aria-label="Decrease scale"
                  disabled={factor <= 0.5}
                  className="grid size-6 place-content-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-40"
                >
                  <Minus className="size-3.5" aria-hidden="true" />
                </button>
                <span className="min-w-10 text-center font-semibold text-foreground tabular-nums">{factor}×</span>
                <button
                  type="button"
                  onClick={() => onFactor(Math.min(8, Math.round((factor + 0.5) * 2) / 2))}
                  aria-label="Increase scale"
                  disabled={factor >= 8}
                  className="grid size-6 place-content-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-40"
                >
                  <Plus className="size-3.5" aria-hidden="true" />
                </button>
              </div>
              <label className="inline-flex items-center gap-2 text-muted-foreground">
                <Switch checked={metric} onChange={(e) => onMetric(e.target.checked)} />
                Metric units
              </label>
            </div>
          </div>

          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {ingredients.length === 0 ? (
              <li className="text-base text-muted-foreground">No ingredients listed.</li>
            ) : (
              ingredients.map((line, i) => {
                const checked = preppedSet.has(i);
                return (
                  <li key={i}>
                    <label
                      data-checked={checked}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-5 rounded-xl border-2 border-border bg-card px-5 py-4 text-2xl shadow-pop-md transition-all hover:bg-accent active:translate-x-px active:translate-y-px active:shadow-none",
                        checked && "border-secondary bg-muted/40 opacity-70 shadow-none",
                      )}
                    >
                      <Checkbox size="xl" checked={checked} onChange={() => onTogglePrep(i)} />
                      <span className="min-w-0 flex-1 leading-snug text-foreground">{line}</span>
                    </label>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      </div>

      {/* Pinned full-width footer — spans edge to edge, sits at the viewport
          bottom, and pads the iOS home-indicator inset. The gradient fades the
          scrolling checklist out beneath the button. */}
      <div className="shrink-0 bg-gradient-to-t from-background via-background/95 to-transparent px-6 pt-8 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]">
        <div className="mx-auto flex w-full max-w-3xl justify-center">
          <Button size="2xl" onClick={onStart} className="w-full max-w-md justify-center">
            Start cooking
          </Button>
        </div>
      </div>
    </div>
  );
}
