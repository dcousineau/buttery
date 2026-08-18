import { Clock, UtensilsCrossed } from "lucide-react";
import { NutritionStrip } from "./NutritionStrip";
import { SourceLink } from "./SourceLink";
import type { RecipeSource } from "#/lib/api";
import type { RecipeNutrition } from "#/lib/api";

/**
 * Presentational recipe reader (plan §A6). Renders entirely from props — no data
 * loading, no mutations — so one component can back both a saved recipe's detail
 * and the create form's Preview (fed in-memory draft state). Images arrive as
 * resolved URLs (a published atproto blob's CDN URL, or a draft's local object
 * URL) so there is no branching inside.
 *
 * Interactive chrome (favorite, cook mode, notes, publish) lives in the callers;
 * this component is deliberately read-only.
 */
export interface RecipeViewData {
  title: string;
  description: string | null;
  images: { url: string; alt: string | null }[];
  ingredients: string[];
  instructions: string[];
  keywords: string[];
  totalTimeDisplay: string | null;
  category: string | null;
  source: RecipeSource | null;
  nutrition: RecipeNutrition;
  serves: number | null;
}

export function RecipeView({ data }: { data: RecipeViewData }) {
  const image = data.images[0] ?? null;
  return (
    <div className="mx-auto flex max-w-[54rem] flex-col gap-3.5">
      <div className="flex flex-col gap-1.5">
        <h1 className="display-title m-0 text-[1.625rem] leading-[1.1] text-balance text-foreground">{data.title || "Untitled recipe"}</h1>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.75rem] font-semibold text-muted-foreground">
          {data.source && <SourceLink source={data.source} />}
          {data.totalTimeDisplay && (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1 whitespace-nowrap">
                <Clock className="size-3.5" aria-hidden="true" />
                {data.totalTimeDisplay}
              </span>
            </>
          )}
          {data.category && (
            <>
              <span aria-hidden>·</span>
              <span className="whitespace-nowrap">{data.category}</span>
            </>
          )}
        </div>
      </div>

      {data.description && <p className="m-0 text-sm text-foreground text-pretty">{data.description}</p>}

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-3.5">
          <div className="grid aspect-[4/3] w-full place-content-center overflow-hidden rounded-lg border-2 border-border bg-muted">
            {image ? (
              <img src={image.url} alt={image.alt ?? ""} className="size-full object-cover" />
            ) : (
              <UtensilsCrossed className="size-10 text-muted-foreground" aria-hidden="true" />
            )}
          </div>

          <h2 className="display-title m-0 text-base text-foreground">Ingredients</h2>
          {data.ingredients.filter((l) => l.trim()).length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {data.ingredients
                .filter((l) => l.trim())
                .map((line, i) => (
                  <li key={i} className="flex gap-2 text-[0.8125rem] leading-[1.35] text-foreground">
                    <span className="mt-[5px] size-[5px] shrink-0 rounded-full bg-primary" aria-hidden="true" />
                    <span>{line}</span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="m-0 text-[0.8125rem] text-muted-foreground">No ingredients listed.</p>
          )}

          <NutritionStrip nutrition={data.nutrition} servings={data.serves} />
        </div>

        <div className="flex min-w-0 flex-[1.35_1_320px] flex-col gap-2">
          <h2 className="display-title m-0 text-base text-foreground">Method</h2>
          {data.instructions.filter((l) => l.trim()).length > 0 ? (
            <ol className="m-0 flex list-none flex-col gap-2 p-0">
              {data.instructions
                .filter((l) => l.trim())
                .map((step, i) => (
                  <li key={i} className="flex gap-2.5 text-[0.875rem] leading-[1.45] text-balance text-foreground">
                    <span className="grid size-5 shrink-0 place-content-center rounded-full border-2 border-border bg-primary text-[0.6875rem] font-bold text-primary-foreground">
                      {i + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
            </ol>
          ) : (
            <p className="m-0 text-[0.875rem] text-muted-foreground">No method steps listed.</p>
          )}
        </div>
      </div>
    </div>
  );
}
