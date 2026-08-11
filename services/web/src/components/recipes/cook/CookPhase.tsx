import { useCallback, useEffect, useRef } from "react";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { splitIngredient } from "#/lib/recipe-scale";
import { cn } from "#/lib/utils";
import { MobileCookDock } from "./MobileCookDock";
import { StepView } from "./StepView";
import { TimersPanel } from "./TimersPanel";

/** Programmatic-scroll guard: ignore the scroll observer for ~700ms after we
 * scroll a step into view, so it doesn't fight the animation (plan §4.3). */
const SCROLL_LOCK_MS = 700;

/**
 * The focus-scroll cook phase (plan §4.3). Two columns on md+: a left rail with
 * the (checkable) ingredient list and the pinned per-recipe timers, and the main
 * step column where the centred step is sharp and neighbours dim + blur by
 * distance. 38vh spacers top/bottom let the first/last step reach centre. Click
 * centres a step; scrolling picks the nearest-to-centre; keyboard ↓/→/Space
 * advance, ↑/← go back. On narrow screens the rail collapses into a compact
 * footer dock (`MobileCookDock`) whose ingredient + timer sheets open on demand.
 */
export function CookPhase({
  steps,
  focus,
  setFocus,
  ingredients,
  prepped,
  onTogglePrep,
  recipeId,
  recipeTitle,
  onBack,
  onFinish,
}: {
  steps: string[];
  focus: number;
  setFocus: (i: number) => void;
  ingredients: string[];
  prepped: number[];
  onTogglePrep: (index: number) => void;
  recipeId: string;
  recipeTitle: string;
  onBack: () => void;
  onFinish: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stepRefs = useRef<(HTMLLIElement | null)[]>([]);
  const lockUntil = useRef(0);
  const rafId = useRef<number | null>(null);
  const last = steps.length - 1;

  const centerStep = useCallback((index: number, behavior: ScrollBehavior) => {
    const el = stepRefs.current[index];
    if (!el) return;
    lockUntil.current = Date.now() + SCROLL_LOCK_MS;
    el.scrollIntoView({ block: "center", behavior });
  }, []);

  const go = useCallback(
    (delta: number) => {
      const next = Math.min(last, Math.max(0, focus + delta));
      if (next === focus) return;
      setFocus(next);
      centerStep(next, "smooth");
    },
    [focus, last, setFocus, centerStep],
  );

  // Centre the focused step on mount / when focus is set externally (Resume).
  useEffect(() => {
    centerStep(focus, "auto");
    // Only on mount: focus-driven centring during interaction is handled by go()/click.
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);

  // Scroll observer: pick the step nearest the container centre (rAF-throttled).
  function onScroll() {
    if (Date.now() < lockUntil.current) return;
    if (rafId.current != null) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = null;
      const container = containerRef.current;
      if (!container) return;
      const crect = container.getBoundingClientRect();
      const mid = crect.top + crect.height / 2;
      let best = 0;
      let bestDist = Infinity;
      stepRefs.current.forEach((el, i) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const d = Math.abs(r.top + r.height / 2 - mid);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      if (best !== focus) setFocus(best);
    });
  }

  // Keyboard navigation while the cook phase is mounted. Registered in the
  // *capture* phase on `document` so it fires before any nested control (the
  // Dialog focus scope, timer buttons, the checkbox) can swallow the event —
  // bubble-phase `window` listeners were reached only when focus happened to
  // sit somewhere that let the key bubble, which is why arrows worked only
  // sometimes. Arrows are ignored while a text field is focused so typing keeps
  // working. Right/Left mirror Down/Up (§4.3).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable === true;
      if (typing) return;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      } else if (e.key === " " || e.code === "Space") {
        if (tag === "BUTTON") return; // let the focused control take the Space
        e.preventDefault();
        go(1);
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [go]);

  return (
    <div className="flex h-full min-h-0">
      {/* Left rail (md+): checkable ingredients + pinned timers. */}
      <aside className="hidden w-[clamp(18rem,26vw,22rem)] shrink-0 flex-col border-r-2 border-border md:flex">
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
          <IngredientChecklist ingredients={ingredients} prepped={prepped} onTogglePrep={onTogglePrep} />
          <button
            type="button"
            onClick={onBack}
            className="mt-1 w-fit rounded-md text-sm font-semibold text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Back to mise en place
          </button>
        </div>
        <div className="border-t-2 border-border px-4 py-4">
          <TimersPanel recipeId={recipeId} />
        </div>
      </aside>

      {/* Main step column. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div ref={containerRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-6 sm:px-12 lg:px-20">
          {/* Top spacer lets step 1 reach centre. */}
          <div aria-hidden="true" style={{ height: "38vh" }} />
          {/* Full available width with generous side padding (no narrow max-width cap). */}
          <ol className="m-0 flex list-none flex-col gap-[7vh] p-0">
            {steps.map((text, i) => (
              <StepView
                key={i}
                ref={(el) => {
                  stepRefs.current[i] = el;
                }}
                text={text}
                index={i}
                total={steps.length}
                distance={Math.abs(i - focus)}
                active={i === focus}
                recipeId={recipeId}
                recipeTitle={recipeTitle}
                onActivate={() => {
                  setFocus(i);
                  centerStep(i, "smooth");
                }}
              />
            ))}
          </ol>
          <div aria-hidden="true" style={{ height: "38vh" }} />
        </div>

        {/* Footer: mobile-only compact dock (ingredient + timer sheets), then the
            step nav. The dock keeps timers collapsed by default. Bottom padding
            clears the iOS home-indicator inset. */}
        <div className="flex flex-col gap-3 border-t-2 border-border bg-background/95 px-6 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
          <MobileCookDock recipeId={recipeId} ingredients={ingredients} />
          <div className="flex items-center justify-between gap-3">
            <span aria-live="polite" className="text-sm font-semibold text-muted-foreground md:hidden">
              Step {focus + 1} of {steps.length}
            </span>
            <div className="ml-auto flex items-center gap-3">
              <Button variant="outline" size="lg" onClick={() => (focus > 0 ? go(-1) : onBack())}>
                <ArrowLeft data-icon="inline-start" aria-hidden="true" />
                Back
              </Button>
              {focus < last ? (
                <Button variant="secondary" size="lg" onClick={() => go(1)}>
                  Next step
                  <ArrowRight data-icon="inline-end" aria-hidden="true" />
                </Button>
              ) : (
                <Button size="lg" onClick={onFinish}>
                  <Check data-icon="inline-start" aria-hidden="true" />
                  Finish
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The cook-phase ingredient checklist — the scaled lines as compact checkable
 * rows with a right-aligned amount chip, sharing the mise `prepped` state. */
function IngredientChecklist({ ingredients, prepped, onTogglePrep }: { ingredients: string[]; prepped: number[]; onTogglePrep: (index: number) => void }) {
  const preppedSet = new Set(prepped);
  const doneCount = ingredients.reduce((n, _line, i) => n + (preppedSet.has(i) ? 1 : 0), 0);

  return (
    <section aria-label="Ingredients" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="display-title m-0 text-base text-foreground">Ingredients</h2>
        <span aria-live="polite" className="text-xs font-semibold text-muted-foreground">
          {doneCount} of {ingredients.length} prepped
        </span>
      </div>
      {ingredients.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">No ingredients listed.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {ingredients.map((line, i) => {
            const { amount, name } = splitIngredient(line);
            const checked = preppedSet.has(i);
            return (
              <li key={i}>
                <label
                  data-checked={checked}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-lg border-2 border-border bg-card px-3 py-2.5 text-sm transition-colors hover:bg-accent",
                    checked && "border-secondary bg-muted/40 opacity-70",
                  )}
                >
                  <Checkbox checked={checked} onChange={() => onTogglePrep(i)} />
                  <span className="min-w-0 flex-1 leading-snug text-foreground">{name}</span>
                  {amount && <span className="shrink-0 text-xs font-medium text-muted-foreground tabular-nums">{amount}</span>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
