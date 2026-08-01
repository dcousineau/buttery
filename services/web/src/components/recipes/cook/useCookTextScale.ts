import { useCallback, useState } from "react";
import { readJSON, writeJSON } from "#/lib/timers/storage";

/**
 * Cook-mode instruction text scale — a user-set multiplier applied to the step
 * font size, persisted across sessions. Cook mode is arm's-length reading, so
 * some cooks want it larger; the floor is chosen so the smallest rendered text
 * still nets ≥16px (see the `max(1rem, …)` clamp in {@link StepView}).
 *
 * Client-only, like the rest of cook mode — read straight from localStorage in a
 * lazy initializer (this subtree never SSRs, so there is no hydration mismatch).
 */
const STORAGE_KEY = "buttery:cookscale:v1";
export const MIN_COOK_SCALE = 0.7;
export const MAX_COOK_SCALE = 1.7;
const STEP = 0.15;
const EPSILON = 1e-6;

function clampScale(n: number): number {
  return Math.min(MAX_COOK_SCALE, Math.max(MIN_COOK_SCALE, Math.round(n * 100) / 100));
}

export function useCookTextScale() {
  const [scale, setScale] = useState<number>(() => {
    const saved = readJSON<number>(STORAGE_KEY);
    return typeof saved === "number" && Number.isFinite(saved) ? clampScale(saved) : 1;
  });

  const set = useCallback((next: number) => {
    const clamped = clampScale(next);
    setScale(clamped);
    writeJSON(STORAGE_KEY, clamped);
  }, []);

  return {
    scale,
    increase: () => set(scale + STEP),
    decrease: () => set(scale - STEP),
    canIncrease: scale < MAX_COOK_SCALE - EPSILON,
    canDecrease: scale > MIN_COOK_SCALE + EPSILON,
  };
}
