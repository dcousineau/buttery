import { useRecipeTimers } from "#/lib/timers/store";
import { TimerRow } from "./TimerRow";

/**
 * The on-recipe timer strip (plan §6.5): the timers **for this recipe**, shown on
 * the detail pane and in cook mode's `TimersPanel`, so a cook looking at the
 * recipe sees its running/alarming timers without opening the header popover.
 * Renders nothing when the recipe has no timers.
 */
export function RecipeTimerStrip({ recipeId, showRecipe = false, className }: { recipeId: string; showRecipe?: boolean; className?: string }) {
  const timers = useRecipeTimers(recipeId);
  if (timers.length === 0) return null;

  // Alarming first, then the rest (store order = newest first within each).
  const ordered = [...timers].sort((a, b) => Number(b.status === "alarming") - Number(a.status === "alarming"));

  return (
    <section aria-label="Timers for this recipe" className={className}>
      <h2 className="display-title mb-2 text-base text-foreground">Timers</h2>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {ordered.map((timer) => (
          <li key={timer.id}>
            <TimerRow timer={timer} showRecipe={showRecipe} />
          </li>
        ))}
      </ul>
    </section>
  );
}
