import { ChevronDown, ListChecks } from "lucide-react";
import { cn } from "#/lib/utils";

/**
 * A collapsible ingredient reference during the cook phase — the scaled lines,
 * available at a glance without leaving the current step. Read-only.
 */
export function IngredientRail({ ingredients, open, onToggle }: { ingredients: string[]; open: boolean; onToggle: () => void }) {
  if (ingredients.length === 0) return null;
  return (
    <div className="rounded-xl border-2 border-border bg-card/60">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ListChecks className="size-4 text-muted-foreground" aria-hidden="true" />
        Ingredients
        <span className="text-sm font-normal text-muted-foreground">({ingredients.length})</span>
        <ChevronDown className={cn("ml-auto size-4 transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && (
        <ul className="m-0 flex list-none flex-col gap-1.5 border-t-2 border-border/60 px-4 py-3 p-0">
          {ingredients.map((line, i) => (
            <li key={i} className="flex gap-2 text-base leading-snug text-foreground">
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
