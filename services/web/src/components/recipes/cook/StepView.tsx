import { forwardRef } from "react";
import { cn } from "#/lib/utils";
import { StepText } from "../StepText";

/** Focus-scroll dim/blur by distance from the centred step (plan §4.3). */
const OPACITY = [1, 0.44, 0.26, 0.16];
const BLUR_PX = [0, 1, 2.4, 3.8];

/**
 * One large cook step. The centred step is sharp; neighbours dim + blur by
 * distance. Clicking a step centres it; its durations are live {@link StepText}
 * time tokens (cook styling). Presentational — `CookPhase` owns focus + the
 * scroll observer and passes `distance`.
 */
export const StepView = forwardRef<
  HTMLLIElement,
  {
    text: string;
    index: number;
    total: number;
    distance: number;
    active: boolean;
    recipeId: string;
    recipeTitle: string;
    onActivate: () => void;
  }
>(function StepView({ text, index, total, distance, active, recipeId, recipeTitle, onActivate }, ref) {
  const clamped = Math.min(distance, OPACITY.length - 1);
  // A plain clickable region, NOT a <button>: the step contains its own
  // <button> time tokens, and nesting interactives is invalid + breaks AT.
  // Click-to-centre is a pointer affordance; keyboard users advance with the
  // arrow keys (CookPhase), so this needs no role/tabindex.
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- click-to-centre is a pointer-only enhancement; keyboard users advance with the arrow keys handled in CookPhase, so no per-step key listener is wanted here.
    <li
      ref={ref}
      data-step-index={index}
      aria-current={active ? "step" : undefined}
      onClick={onActivate}
      className={cn("flex list-none gap-4 transition-[opacity,filter] duration-300 sm:gap-5", !active && "cursor-pointer")}
      style={{ opacity: OPACITY[clamped], filter: BLUR_PX[clamped] ? `blur(${BLUR_PX[clamped]}px)` : undefined }}
    >
      <span aria-hidden="true" className={cn("shrink-0 pt-1 font-mono text-xl font-bold tabular-nums sm:text-2xl", active ? "text-primary" : "text-muted-foreground/70")}>
        {String(index + 1).padStart(2, "0")}
      </span>
      <span className="min-w-0 flex-1">
        <span className="sr-only">
          Step {index + 1} of {total}.{" "}
        </span>
        {/* Base clamp scaled by the user's cook-mode text factor, floored at 1rem
            (16px) so the smallest setting on a narrow screen stays legible. */}
        <span
          className="block leading-[1.28] font-medium text-balance text-foreground"
          style={{ fontSize: "max(1rem, calc(var(--cook-text-scale, 1) * clamp(1.7rem, 3.4vw, 2.7rem)))" }}
        >
          <StepText text={text} recipeId={recipeId} recipeTitle={recipeTitle} variant="cook" />
        </span>
      </span>
    </li>
  );
});
