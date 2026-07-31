import { createContext, useContext } from "react";

/**
 * View state shared across the recipes master–detail while the ledger stays
 * mounted (plan §5.3). `factor`/`metric` are ephemeral reading prefs shared
 * across recipes for the session (not per recipe, not persisted); `openPicker`
 * and `pushToast` are lifted so the detail pane's "Add" / stub buttons drive the
 * shell's global picker and toast queue.
 */
export interface RecipesView {
  factor: number;
  setFactor: (n: number) => void;
  metric: boolean;
  setMetric: (b: boolean) => void;
  /** Open the global recipe picker (the "Add" affordance). */
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
