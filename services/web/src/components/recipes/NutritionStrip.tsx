import type { RecipeNutrition } from "#/server/household-recipes";

/**
 * Per-serving nutrition strip (design handoff). Per-serving values do NOT change
 * with scale; only the displayed servings count does (`round(serves × factor)`).
 * Hides individual cells — and the whole strip — when values are null.
 */
export function NutritionStrip({ nutrition, servings }: { nutrition: RecipeNutrition; servings: number | null }) {
  const cells: Array<{ label: string; value: string }> = [];
  if (nutrition.calories != null) cells.push({ label: "kcal", value: String(Math.round(nutrition.calories)) });
  if (nutrition.protein != null) cells.push({ label: "protein", value: `${Math.round(nutrition.protein)}g` });
  if (nutrition.carbs != null) cells.push({ label: "carbs", value: `${Math.round(nutrition.carbs)}g` });
  if (nutrition.fat != null) cells.push({ label: "fat", value: `${Math.round(nutrition.fat)}g` });
  if (cells.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-lg border-2 border-border bg-card">
      <div className="flex items-center justify-between border-b-2 border-border px-2.5 py-1.5">
        <span className="display-title text-[0.8125rem] text-foreground">Nutrition</span>
        <span className="text-[0.6875rem] font-semibold text-muted-foreground">per serving{servings != null ? ` · ${servings} serving${servings === 1 ? "" : "s"}` : ""}</span>
      </div>
      <div className="grid gap-0.5 bg-border/45 [grid-template-columns:repeat(auto-fit,minmax(74px,1fr))]">
        {cells.map((c) => (
          <div key={c.label} className="bg-card px-2.5 py-1.5">
            <div className="text-[0.9375rem] font-bold whitespace-nowrap text-foreground">{c.value}</div>
            <div className="text-[0.625rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">{c.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
