import { Clock, UtensilsCrossed } from "lucide-react";
import { NutritionStrip } from "./NutritionStrip";
import { SourceLink } from "./SourceLink";
import type { RecipeSource } from "#/lib/api";
import type { RecipeNutrition } from "#/lib/api";
import type { RecipeDetailData } from "#/lib/api";
import { formatDuration } from "#/lib/format";
import { parseServes } from "#/lib/recipe-scale";

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

/**
 * `RecipeDetailData` (the public/corpus recipe payload, `lib/api/types.ts`) →
 * `RecipeViewData`. Added for the meal randomizer (plan §4.5, §7): a corpus
 * draw is not in the household box, so `DetailPane` — which reads a
 * `HouseholdRecipeDetail` — cannot render it, and this component (already
 * built to be data-only and presentational) is the one that can. A pure data
 * mapper, not markup, so §7.2's "do not copy markup out of DetailPane" rule
 * does not apply to it — nothing here renders anything.
 *
 * Field-by-field notes on the parts that are not a straight rename:
 * - `totalTimeDisplay` — `RecipeDetailData.totalTime` is an ISO-8601 duration
 *   ("PT1H30M"); `formatDuration` renders it the same way `minutesDisplay`
 *   does server-side ("1h 30m"), so a corpus card and a box card read
 *   identically. See {@link displayDuration} for the one case it can't.
 * - `serves` — `RecipeDetailData` carries `recipeYield` as free text ("4
 *   servings"), not a parsed integer; `parseServes` is the same leading-integer
 *   parser `DetailPane`'s scaling and the public recipe page both already use.
 * - `nutrition` — `RecipeDetailData` only ever carries `calories` (no
 *   protein/carbs/fat estimation exists at all, corpus or box); the other
 *   three cells are `null`, same as an unenriched box recipe's would be.
 * - `source` — `RecipeDetailData` has no ready-made `RecipeSource`; built here
 *   from `attribution`/`publishedBy`/`publisherUrl` in the same priority
 *   `deriveSource` uses server-side (a resolved URL, then a resolved handle,
 *   then a bare attribution name), so a corpus result's byline reads the same
 *   as everywhere else `SourceLink` renders one.
 */
export function recipeViewDataFromDetail(detail: RecipeDetailData): RecipeViewData {
  return {
    title: detail.name,
    description: detail.description,
    images: detail.images.map((img) => ({ url: img.url, alt: img.alt })),
    ingredients: detail.ingredients,
    instructions: detail.instructions,
    keywords: detail.keywords,
    totalTimeDisplay: displayDuration(detail.totalTime),
    category: detail.category,
    source: sourceFromDetail(detail),
    nutrition: { calories: detail.calories, protein: null, carbs: null, fat: null },
    serves: parseServes(detail.recipeYield),
  };
}

/**
 * A recipe time a reader can read, or nothing.
 *
 * `formatDuration` returns its INPUT unchanged when the duration parses to zero
 * or less (`lib/format.ts`) — a deliberate "don't lose data" fallback for a
 * string it can't make sense of. A published recipe carrying `"PT0S"` is common
 * enough on the network to matter, and passing it straight through renders the
 * literal `PT0S` in a meta row: browser-verified on a corpus draw, whose byline
 * read "Red Thai Coconut Chicken Soup - Peanut variation · PT0S". A duration
 * with no duration in it is not a time; the meta row already omits the segment
 * when this is `null`, which is the honest answer.
 */
function displayDuration(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const formatted = formatDuration(iso);
  return formatted === iso ? null : formatted;
}

/** See {@link recipeViewDataFromDetail}'s doc for the priority this mirrors. */
function sourceFromDetail(detail: RecipeDetailData): RecipeSource | null {
  const a = detail.attribution;
  if (a?.url) {
    const domain = domainOf(a.url);
    return { kind: "web", label: domain ?? a.displayName ?? a.author ?? a.publisher ?? a.url, url: a.url };
  }
  if (detail.publishedBy) {
    // `publishedBy` is already "@handle"-prefixed when it resolved from a
    // handle (`server/recipes.ts`); a short-DID or display-name fallback
    // still reads fine unprefixed, so no branching on shape here.
    return { kind: detail.publishedBy.startsWith("@") ? "handle" : "note", label: detail.publishedBy, url: detail.publisherUrl };
  }
  const name = a?.displayName ?? a?.author ?? a?.publisher;
  return name ? { kind: "note", label: name, url: null } : null;
}

/** Bare hostname ("https://www.smittenkitchen.com/…" → "smittenkitchen.com"). Mirrors `lib/recipe-provenance.ts`'s private `domainOf`, which is not exported. */
function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
