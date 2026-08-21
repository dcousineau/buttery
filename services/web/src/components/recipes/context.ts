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
/**
 * The optional half of a toast. Everything here defaults to the plain
 * success-confirmation shape the shell has always pushed; the extras exist for
 * the collections publish surfaces (§5), where a write can succeed locally and
 * still have something left to say — "Saved — couldn't update @sam's published
 * copy yet", with a Retry.
 */
export interface ToastOptions {
  description?: string;
  variant?: "default" | "success" | "destructive";
  /** One control on the toast. Pushing an action without `sticky` is a bug. */
  action?: { label: string; onClick: () => void };
  /** Stay until dismissed — for anything the reader is expected to act on. */
  sticky?: boolean;
}

export interface RecipesView {
  /** Open the "Add a recipe" chooser modal (the primary "Add" affordance). */
  openAddChooser: () => void;
  /** Open the global recipe picker directly (the chooser's "existing" branch). */
  openPicker: () => void;
  /** Push a transient confirmation toast (stub actions + success chips). */
  pushToast: (message: string, options?: ToastOptions) => void;
}

export const RecipesViewContext = createContext<RecipesView | null>(null);

export function useRecipesView(): RecipesView {
  const ctx = useContext(RecipesViewContext);
  if (!ctx) throw new Error("useRecipesView must be used within the recipes layout.");
  return ctx;
}
