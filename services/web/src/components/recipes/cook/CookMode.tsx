import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AArrowDown, AArrowUp, Maximize, Minimize, X } from "lucide-react";
import { usePostHog } from "@posthog/react";
import { Dialog, DialogContent, DialogTitle } from "#/components/ui/dialog";
import { Button } from "#/components/ui/button";
import { CheckboxRow } from "#/components/ui/checkbox";
import { getCookedCandidates, setMealPlanEntryCooked } from "#/server/meal-plan";
import { SLOT_LABELS } from "#/lib/plan/labels";
import type { MealSlot } from "#/lib/plan/week";
import { scaleIngredients } from "#/lib/recipe-scale";
import { useTimers } from "#/lib/timers/store";
import { useRecipeScale } from "../scale";
import { MisePhase } from "./MisePhase";
import { CookPhase } from "./CookPhase";
import { useWakeLock } from "./useWakeLock";
import { useCookTextScale } from "./useCookTextScale";
import { clearCookState, loadCookState, saveCookState, type CookState } from "./useCookPersistence";

type Phase = "mise" | "cook";

/**
 * The minimal recipe shape cook mode reads. Both the private household detail
 * (`HouseholdRecipeDetail`) and the public detail (`RecipeDetailData`, adapted)
 * satisfy it structurally, so cook mode works on either page.
 */
export interface CookRecipe {
  recipeId: string;
  title: string;
  ingredients: string[];
  instructions: string[];
  serves: number | null;
  totalTimeDisplay: string | null;
}

/** Minimal typing for the vendor-prefixed Fullscreen API (iPadOS / older Safari). */
interface FsElement extends HTMLDivElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}
interface FsDocument extends Document {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

/**
 * Cook mode (plan §4–§9). A strictly client-only, lazy-loaded immersive surface:
 * a fullscreen DS `Dialog` (focus trap + body-scroll lock) rendered in the app's
 * **dark** theme regardless of the current theme. Two phases — mise en place and
 * the focus-scroll cook view — over the already-loaded recipe (no re-fetch). It
 * reads/writes the **global** timer store (no private timer state), holds a wake
 * lock during the cook phase, persists cook-view state per-recipe with a Resume
 * offer, and can escalate to the browser Fullscreen API where supported.
 *
 * Default export so `CookModeOverlay`'s `React.lazy` can code-split the whole
 * subtree (this file + everything it imports) out of the recipe and plan route
 * bundles.
 */
export default function CookMode({ recipe, onClose }: { recipe: CookRecipe; onClose: () => void }) {
  const posthog = usePostHog();
  const { factor, setFactor, metric, setMetric } = useRecipeScale();
  const { arm } = useTimers();
  const { scale, increase, decrease, canIncrease, canDecrease } = useCookTextScale();

  // Load any saved session exactly once (client-only — this subtree never SSRs).
  const [saved] = useState<CookState | null>(() => loadCookState(recipe.recipeId));

  const [resume, setResume] = useState<"pending" | "done">(saved ? "pending" : "done");
  const [phase, setPhase] = useState<Phase>("mise");
  const [focus, setFocus] = useState(0);
  const [prepped, setPrepped] = useState<number[]>([]);

  const rootRef = useRef<FsElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // §7.1: today's still-uncooked plan entries for this recipe, asked for once,
  // at the moment the cook says they are done. Null ⇒ no prompt.
  const [cookPrompt, setCookPrompt] = useState<Array<{ entryId: string; slot: MealSlot }> | null>(null);
  const [cookPromptPicked, setCookPromptPicked] = useState<string[]>([]);
  const focusCookPrompt = useCallback((node: HTMLDivElement | null) => node?.focus(), []);

  const scaledIngredients = useMemo(() => scaleIngredients(recipe.ingredients, factor, metric), [recipe.ingredients, factor, metric]);
  const serves = recipe.serves != null ? Math.max(1, Math.round(recipe.serves * factor)) : null;
  const subtitle = ["Cook mode", serves != null ? `serves ${serves}` : null, recipe.totalTimeDisplay ? `about ${recipe.totalTimeDisplay}` : null].filter(Boolean).join(" · ");

  useWakeLock(phase === "cook" && resume !== "pending");

  // Hide the PostHog Conversations support widget while cook mode is open — its
  // floating bubble would overlap the immersive surface. Poll briefly to also
  // catch a late-loading widget, then restore it on exit. `__root` re-shows it
  // on signed-in routes, so a plain show() on cleanup is enough.
  useEffect(() => {
    const conversations = posthog.conversations;
    if (!conversations) return;
    conversations.hide();
    const timer = setInterval(() => {
      if (conversations.isAvailable()) {
        conversations.hide();
        clearInterval(timer);
      }
    }, 500);
    const stop = setTimeout(() => clearInterval(timer), 10_000);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
      conversations.show();
    };
  }, [posthog]);

  // Persist cook-view state (debounced), but only once the Resume choice is made.
  useEffect(() => {
    if (resume === "pending") return;
    const t = setTimeout(() => saveCookState(recipe.recipeId, { phase, focus, prepped, factor, metric }), 300);
    return () => clearTimeout(t);
  }, [resume, phase, focus, prepped, factor, metric, recipe.recipeId]);

  // Flush on hide so a backgrounded/closed tab keeps the cook's place.
  useEffect(() => {
    function onHide() {
      if (resume !== "pending") saveCookState(recipe.recipeId, { phase, focus, prepped, factor, metric });
    }
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
    };
  }, [resume, phase, focus, prepped, factor, metric, recipe.recipeId]);

  // ---- Fullscreen escalation (§5) ----
  const fsDoc = typeof document !== "undefined" ? (document as FsDocument) : null;
  const supportsFullscreen = Boolean(fsDoc && (fsDoc.fullscreenEnabled || fsDoc.webkitFullscreenEnabled));

  useEffect(() => {
    const doc = document as FsDocument;
    function onChange() {
      setIsFullscreen(Boolean(doc.fullscreenElement || doc.webkitFullscreenElement));
    }
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  const enterFullscreen = useCallback(async () => {
    const el = rootRef.current;
    if (!el) return;
    try {
      await (el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.());
    } catch {
      /* iPadOS element fullscreen is flaky — the fixed overlay is already immersive */
    }
  }, []);

  const exitFullscreen = useCallback(async () => {
    const doc = document as FsDocument;
    try {
      await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
    } catch {
      /* ignore */
    }
  }, []);

  const handleExit = useCallback(async () => {
    const doc = document as FsDocument;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) await exitFullscreen();
    if (resume !== "pending") saveCookState(recipe.recipeId, { phase, focus, prepped, factor, metric });
    onClose();
  }, [exitFullscreen, resume, phase, focus, prepped, factor, metric, recipe.recipeId, onClose]);

  // Dialog dismissals: Esc from the cook phase drops back to mise (plan §4.3);
  // Esc / close from mise exits.
  function onOpenChange(open: boolean) {
    if (open) return;
    // Esc while the cooked prompt is up answers it with "not this time" and
    // leaves — the session is already over at that point.
    if (cookPrompt) {
      dismissCookPrompt();
      return;
    }
    if (phase === "cook") {
      setPhase("mise");
      return;
    }
    void handleExit();
  }

  function onResume() {
    if (!saved) return;
    setPhase(saved.phase);
    setFocus(saved.focus);
    setPrepped(saved.prepped);
    setFactor(saved.factor);
    setMetric(saved.metric);
    setResume("done");
  }

  function onStartFresh() {
    clearCookState(recipe.recipeId);
    setResume("done");
  }

  function onStart() {
    arm(); // unlock audio + request notification permission from this gesture
    posthog.capture("cook_session_started", { recipe_id: recipe.recipeId });
    setPhase("cook");
    setFocus((f) => (phase === "mise" ? 0 : f));
  }

  /**
   * Finishing a cook (§7.1). The session is over either way; the only question
   * is whether the planner learns about it.
   *
   * The lookup is fast (indexed on household + recipe + date) and its failure is
   * swallowed on purpose: cook mode works for someone who has never opened the
   * planner, and a planner outage must not trap a cook in a dialog they finished
   * with. No candidates ⇒ nothing changes at all.
   */
  async function finishCooking() {
    clearCookState(recipe.recipeId);
    posthog.capture("cook_session_completed", { recipe_id: recipe.recipeId });
    try {
      const candidates = await getCookedCandidates({ data: { recipeId: recipe.recipeId } });
      if (candidates.length > 0) {
        posthog.capture("meal_plan_cook_prompt_shown", { recipe_id: recipe.recipeId, candidates: candidates.length });
        setCookPrompt(candidates.map(({ entryId, slot }) => ({ entryId, slot })));
        // Everything pre-picked: one candidate is a plain confirm, and with
        // several the common answer is "all of them".
        setCookPromptPicked(candidates.map((candidate) => candidate.entryId));
        return;
      }
    } catch {
      /* the planner never blocks the exit */
    }
    await handleExit();
  }

  function onFinish() {
    void finishCooking();
  }

  function dismissCookPrompt() {
    posthog.capture("meal_plan_cook_prompt_dismissed", { recipe_id: recipe.recipeId, candidates: cookPrompt?.length ?? 0 });
    setCookPrompt(null);
    void handleExit();
  }

  function confirmCookPrompt() {
    const picked = cookPromptPicked;
    posthog.capture("meal_plan_cook_prompt_confirmed", { recipe_id: recipe.recipeId, candidates: cookPrompt?.length ?? 0, marked: picked.length });
    setCookPrompt(null);
    void (async () => {
      // `allSettled`: one entry that vanished from the plan mid-cook must not
      // cost the others their mark, and there is no surface left to report on.
      await Promise.allSettled(picked.map((entryId) => setMealPlanEntryCooked({ data: { entryId, cooked: true } })));
      await handleExit();
    })();
  }

  function togglePrep(i: number) {
    setPrepped((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]));
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="fullscreen" className="dark p-0">
        <div
          ref={rootRef}
          style={{ "--cook-text-scale": scale } as React.CSSProperties}
          className="relative isolate flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
        >
          {/* Ambient blurred gradient blobs (decorative; reduced-motion disables drift). */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
            <div className="absolute -top-1/4 -left-10 size-[45vmax] rounded-full bg-primary/15 blur-3xl motion-safe:animate-cook-blob-a" />
            <div className="absolute -right-10 -bottom-1/4 size-[40vmax] rounded-full bg-secondary/15 blur-3xl motion-safe:animate-cook-blob-b" />
          </div>

          {/* Top bar (pad the notch/status-bar inset on iOS standalone/fullscreen). */}
          <div className="flex items-center justify-between gap-3 border-b-2 border-border/60 px-6 pt-[calc(0.75rem+env(safe-area-inset-top,0px))] pb-3">
            <div className="min-w-0">
              <DialogTitle size="default" className="display-title truncate text-lg text-secondary">
                {recipe.title}
              </DialogTitle>
              <p className="m-0 truncate text-xs font-semibold text-muted-foreground">{subtitle}</p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {phase === "cook" && (
                <span aria-live="polite" className="hidden text-sm font-semibold text-muted-foreground md:inline">
                  Step {focus + 1} of {recipe.instructions.length}
                </span>
              )}
              {/* Instruction text size — persisted scale factor, floored so the
                  smallest rendered step stays ≥16px (see StepView). */}
              <div role="group" aria-label="Instruction text size" className="inline-flex overflow-hidden rounded-lg border-2 border-border bg-card">
                <button
                  type="button"
                  onClick={decrease}
                  disabled={!canDecrease}
                  aria-label="Decrease text size"
                  className="grid size-7 place-content-center text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                >
                  <AArrowDown className="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={increase}
                  disabled={!canIncrease}
                  aria-label="Increase text size"
                  className="grid size-7 place-content-center border-l-2 border-border text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                >
                  <AArrowUp className="size-4.5" aria-hidden="true" />
                </button>
              </div>
              {supportsFullscreen && (
                <Button variant="outline" size="sm" onClick={() => (isFullscreen ? void exitFullscreen() : void enterFullscreen())}>
                  {isFullscreen ? <Minimize data-icon="inline-start" aria-hidden="true" /> : <Maximize data-icon="inline-start" aria-hidden="true" />}
                  {isFullscreen ? "Exit fullscreen" : "Go fullscreen"}
                </Button>
              )}
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => void handleExit()}>
                <X data-icon="inline-start" aria-hidden="true" />
                Exit cook mode
              </Button>
            </div>
          </div>

          {/* Body */}
          <div className="min-h-0 flex-1 overflow-hidden">
            {phase === "mise" ? (
              // MisePhase owns its full-height layout (scroll area + pinned
              // full-width footer), so the "Start cooking" bar can reach the
              // viewport edges + bottom.
              <MisePhase
                title={recipe.title}
                ingredients={scaledIngredients}
                serves={serves}
                prepped={prepped}
                onTogglePrep={togglePrep}
                factor={factor}
                metric={metric}
                onFactor={setFactor}
                onMetric={setMetric}
                onStart={onStart}
              />
            ) : (
              <CookPhase
                steps={recipe.instructions}
                focus={focus}
                setFocus={setFocus}
                ingredients={scaledIngredients}
                prepped={prepped}
                onTogglePrep={togglePrep}
                recipeId={recipe.recipeId}
                recipeTitle={recipe.title}
                onBack={() => setPhase("mise")}
                onFinish={onFinish}
              />
            )}
          </div>

          {/* Cooked prompt (meal planner §7.1) — same overlay grammar as Resume. */}
          {cookPrompt && (
            <div className="absolute inset-0 z-20 grid place-content-center bg-background/85 p-6 backdrop-blur-sm">
              {/* Focus moves to the card itself, not to a button: the cook's
                  focus is still on "Finish" behind the overlay otherwise, and
                  the heading is what has to be read first. A `useCallback` ref
                  rather than `autoFocus` (a11y lint) or an effect — it fires
                  once, on mount, and not on every checkbox toggle. */}
              <div
                ref={focusCookPrompt}
                tabIndex={-1}
                role="group"
                aria-label="Mark as cooked"
                className="flex w-full max-w-sm flex-col gap-3 rounded-xl border-2 border-border bg-card p-5 shadow-pop-md outline-none"
              >
                <h2 className="display-title m-0 text-xl text-foreground">
                  {cookPrompt.length === 1 ? `Mark ${SLOT_LABELS[cookPrompt[0].slot].toLowerCase()} as cooked?` : "Mark these as cooked?"}
                </h2>
                <p className="m-0 text-sm text-muted-foreground">
                  {cookPrompt.length === 1 ? "This recipe is on today's plan." : "This recipe is on today's plan more than once. Pick the ones you just cooked."}
                </p>
                {cookPrompt.length > 1 && (
                  <div className="flex flex-col gap-1.5">
                    {cookPrompt.map((candidate) => (
                      <CheckboxRow
                        key={candidate.entryId}
                        size="sm"
                        checked={cookPromptPicked.includes(candidate.entryId)}
                        onCheckedChange={(checked) => setCookPromptPicked((picked) => (checked ? [...picked, candidate.entryId] : picked.filter((id) => id !== candidate.entryId)))}
                      >
                        {SLOT_LABELS[candidate.slot]}
                      </CheckboxRow>
                    ))}
                  </div>
                )}
                <div className="mt-1 flex justify-end gap-2">
                  <Button variant="outline" onClick={dismissCookPrompt}>
                    Not this time
                  </Button>
                  <Button disabled={cookPromptPicked.length === 0} onClick={confirmCookPrompt}>
                    Mark cooked
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Resume prompt (plan §9.2) */}
          {resume === "pending" && saved && (
            <div className="absolute inset-0 z-20 grid place-content-center bg-background/85 p-6 backdrop-blur-sm">
              <div className="flex w-full max-w-sm flex-col gap-3 rounded-xl border-2 border-border bg-card p-5 shadow-pop-md">
                <h2 className="display-title m-0 text-xl text-foreground">Resume where you left off?</h2>
                <p className="m-0 text-sm text-muted-foreground">
                  You were on {saved.phase === "cook" ? `step ${saved.focus + 1}` : "mise en place"}
                  {saved.prepped.length > 0 ? ` with ${saved.prepped.length} ingredient${saved.prepped.length === 1 ? "" : "s"} prepped` : ""}.
                </p>
                <div className="mt-1 flex justify-end gap-2">
                  <Button variant="outline" onClick={onStartFresh}>
                    Start fresh
                  </Button>
                  <Button onClick={onResume}>Resume</Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
