import { createContext, useContext } from "react";

/**
 * View state shared across the recipes master–detail while the ledger stays
 * mounted (plan §5.3): `openPicker`, `openAddChooser` and `pushToast` are lifted
 * so the detail pane's "Add" / stub buttons drive the shell's global picker and
 * toast queue.
 *
 * Everything here needs the shell to exist. Reading prefs (scale factor, metric)
 * do not, so they live in `RecipeScaleContext` instead — see `./scale`.
 */
export interface RecipesView {
  /** Open the "Add a recipe" chooser modal (the primary "Add" affordance). */
  openAddChooser: () => void;
  /** Open the global recipe picker directly (the chooser's "existing" branch). */
  openPicker: () => void;
  /** Push a transient confirmation toast (stub actions + success chips). */
  pushToast: (message: string) => void;
}

export const RecipesViewContext = createContext<RecipesView | null>(null);

export function useRecipesView(): RecipesView {
  const ctx = useContext(RecipesViewContext);
  if (!ctx) throw new Error("useRecipesView must be used within the recipes layout.");
  return ctx;
}
