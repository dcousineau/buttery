import { createContext, useContext, useState } from "react";

/**
 * How a recipe is being read right now: scaled by `factor`, in metric or not.
 *
 * These are ephemeral session prefs, not per-recipe settings and never
 * persisted. They live apart from `RecipesViewContext` because the surfaces that
 * need them are not the surfaces that need the recipes shell: cook mode reads
 * scale and units, but nothing about the ledger, the picker or the shell's toast
 * queue — and it now opens from the meal planner and the public recipe page,
 * neither of which has a shell to provide those.
 */
export interface RecipeScale {
  factor: number;
  setFactor: (n: number) => void;
  metric: boolean;
  setMetric: (b: boolean) => void;
}

export const RecipeScaleContext = createContext<RecipeScale | null>(null);

/**
 * Inherit the surrounding scale if there is one, otherwise own it.
 *
 * That fallback is the whole point: inside the recipes shell, opening cook mode
 * on a recipe you had already doubled keeps it doubled, and scaling inside the
 * apron is still there when you take it off. Anywhere else — a plan card, the
 * public page — cook mode simply keeps its own, rather than a route having to
 * fake a provider it has no use for.
 *
 * The local state is declared unconditionally (hooks must be), so it costs one
 * unused `useState` pair when a provider is present.
 */
export function useRecipeScale(): RecipeScale {
  const inherited = useContext(RecipeScaleContext);
  const [factor, setFactor] = useState(1);
  const [metric, setMetric] = useState(false);
  return inherited ?? { factor, setFactor, metric, setMetric };
}
