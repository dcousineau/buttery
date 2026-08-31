import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "#/lib/api";
import { Toast, ToastViewport, useToasts } from "#/components/ui/toast";
import { GlobalRecipePicker } from "#/components/recipes/GlobalRecipePicker";
import { AddRecipeChooser } from "#/components/recipes/create/AddRecipeChooser";
import { RecipesViewContext, type ToastOptions } from "#/components/recipes/context";
import { RecipeScaleContext } from "#/components/recipes/scale";

/**
 * The recipes *shell* — everything `DetailPane` and its children reach for
 * through context, in one component, so more than one surface can mount it.
 *
 * It was the provider block inlined in `routes/household.recipes.tsx` until the
 * randomizer needed the same pane on a route of its own
 * (`docs/plans/2026-08-30-meal-randomizer.md` §6.1). Lifting it rather than
 * copying it is the point: a second copy of the toast queue is how two surfaces
 * start disagreeing about what a toast looks like, and `AddRecipeChooser` reads
 * `useRecipesView()` itself, so the chooser and the context that feeds it have
 * to travel together anyway.
 *
 * What it owns, all of it moved verbatim:
 *
 * - `RecipeScaleContext` — the ephemeral scale/units reading prefs, so scaling
 *   survives moving between the ledger, the detail and cook mode.
 * - `RecipesViewContext` — `pushToast`, `openPicker`, `openAddChooser`.
 * - The two global modals (`AddRecipeChooser`, `GlobalRecipePicker`) and the
 *   toast queue + its viewport.
 *
 * What it does NOT own is where "added" goes next. Invalidating the box is the
 * same on every surface and happens here; navigating afterwards is not (the box
 * opens the new recipe in its detail pane, the randomizer has no ledger to
 * select in), so that half arrives as `onAdded`.
 */
export function RecipesViewProvider({
  householdId,
  onAdded,
  children,
}: {
  /** The cache partition — the same value the surrounding route's `beforeLoad` resolved. */
  householdId: string;
  /** Runs after the box cache is invalidated and before the confirmation toast. */
  onAdded?: (recipeId: string) => void | Promise<void>;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [factor, setFactor] = useState(1);
  const [metric, setMetric] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  const { toasts, push, dismiss, pauseAll, resumeAll } = useToasts(4000);

  function pushToast(message: string, options?: ToastOptions) {
    push({ variant: options?.variant ?? "success", title: message, description: options?.description, action: options?.action, sticky: options?.sticky });
  }

  async function handleAdded(recipeId: string) {
    // Prefix-scoped, not `router.invalidate()`: the box gained a row, and
    // nothing else on screen did (§4.2). The whole-router invalidate this
    // replaces also re-ran every other loader in the tree.
    await queryClient.invalidateQueries({ queryKey: keys.household.recipes(householdId) });
    await onAdded?.(recipeId);
    pushToast("Added to your box");
  }

  return (
    <RecipeScaleContext.Provider value={{ factor, setFactor, metric, setMetric }}>
      <RecipesViewContext.Provider value={{ openAddChooser: () => setChooserOpen(true), openPicker: () => setPickerOpen(true), pushToast }}>
        {children}

        <AddRecipeChooser open={chooserOpen} onOpenChange={setChooserOpen} onAddExisting={() => setPickerOpen(true)} />
        <GlobalRecipePicker open={pickerOpen} onOpenChange={setPickerOpen} onAdded={handleAdded} />

        <ToastViewport position="bottom-center" onMouseEnter={pauseAll} onMouseLeave={resumeAll} onFocusCapture={pauseAll} onBlurCapture={resumeAll}>
          {toasts.map((t) => (
            <Toast
              key={t.id}
              variant={t.variant}
              title={t.title}
              description={t.description}
              // Acting on a toast is also done with it: the outcome of the retry
              // arrives as its own toast, and leaving the old one behind would
              // stack two contradictory sentences.
              action={
                t.action
                  ? {
                      label: t.action.label,
                      onClick: () => {
                        t.action?.onClick();
                        dismiss(t.id);
                      },
                    }
                  : undefined
              }
              onClose={() => dismiss(t.id)}
            >
              {/* The tick belongs to a confirmation. A toast reporting that
                something did NOT finish carries no icon rather than a wrong one. */}
              {t.variant === "success" || t.variant === undefined ? <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> : null}
            </Toast>
          ))}
        </ToastViewport>
      </RecipesViewContext.Provider>
    </RecipeScaleContext.Provider>
  );
}
