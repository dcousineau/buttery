import { snakeCase, startCase } from "es-toolkit";

/**
 * Client-safe controlled vocabulary for the recipe token dimensions (cuisine,
 * category, cooking method, diet). This mirrors the seed in migration
 * `1785300000000_create_recipe_rendered.ts` EXACTLY, so:
 *
 *   - the create form offers only values the sync index already knows, and
 *   - a locally-authored recipe's rendered `recipe.*` columns store the same
 *     internal slug the cron would derive (via `recipe_vocab_alias`) for a synced
 *     copy — local + synced rows render identically (plan §A2.5).
 *
 * The atproto record itself carries the upstream NSID token
 * (`exchange.recipe.defs#<prefix><PascalSuffix>`), NOT the slug; `tokenForSlug` /
 * `slugForToken` bridge the two. No DB import — safe in the client bundle.
 */

export type VocabDimension = "cuisine" | "category" | "cooking_method" | "diet";

const NSID = "exchange.recipe.defs";

// Upstream token prefix + PascalCase suffixes per dimension (verbatim from the
// migration seed). slug = snakeCase(suffix); label = startCase(suffix).
const SEED: Record<VocabDimension, { prefix: string; suffixes: string[] }> = {
  cuisine: {
    prefix: "cuisine",
    // prettier-ignore
    suffixes: ["African", "American", "Australian", "Brazilian", "British", "Caribbean", "Chinese", "Creole", "European", "French", "German", "Greek", "Indian", "Indonesian", "Italian", "Japanese", "Korean", "Lebanese", "Mediterranean", "Mexican", "MiddleEastern", "Moroccan", "Peruvian", "Polish", "Portuguese", "Russian", "Southern", "Spanish", "TexMex", "Texan", "Thai", "Turkish", "Vietnamese"],
  },
  category: {
    prefix: "category",
    suffixes: ["Appetizer", "Beverage", "Breakfast", "Brunch", "Cocktail", "Dessert", "Dinner", "Entree", "Garnish", "KidFriendly", "Lunch", "Salad", "Side", "Snack", "Soup"],
  },
  cooking_method: {
    prefix: "cookingMethod",
    suffixes: ["AirFrying", "Baking", "Broiling", "Frying", "Grilling", "NoCook", "PressureCooking", "Roasting", "Sauteing", "SlowCooking", "Steaming"],
  },
  diet: {
    prefix: "diet",
    suffixes: ["Diabetic", "GlutenFree", "Halal", "Keto", "Kosher", "LowCalorie", "LowCarb", "LowFat", "Paleo", "Vegan", "Vegetarian"],
  },
};

export interface VocabOption {
  slug: string;
  label: string;
  token: string;
}

function build(): Record<VocabDimension, VocabOption[]> {
  const out = {} as Record<VocabDimension, VocabOption[]>;
  for (const dim of Object.keys(SEED) as VocabDimension[]) {
    const { prefix, suffixes } = SEED[dim];
    out[dim] = suffixes.map((suffix) => ({
      slug: snakeCase(suffix),
      label: startCase(suffix),
      token: `${NSID}#${prefix}${suffix}`,
    }));
  }
  return out;
}

/** All options per dimension, sorted by label for select menus. */
export const RECIPE_VOCAB: Record<VocabDimension, VocabOption[]> = (() => {
  const built = build();
  for (const dim of Object.keys(built) as VocabDimension[]) {
    built[dim] = [...built[dim]].sort((a, b) => a.label.localeCompare(b.label));
  }
  return built;
})();

const BY_SLUG: Record<VocabDimension, Map<string, VocabOption>> = {
  cuisine: new Map(),
  category: new Map(),
  cooking_method: new Map(),
  diet: new Map(),
};
const BY_TOKEN: Record<VocabDimension, Map<string, VocabOption>> = {
  cuisine: new Map(),
  category: new Map(),
  cooking_method: new Map(),
  diet: new Map(),
};
for (const dim of Object.keys(RECIPE_VOCAB) as VocabDimension[]) {
  for (const opt of RECIPE_VOCAB[dim]) {
    BY_SLUG[dim].set(opt.slug, opt);
    BY_TOKEN[dim].set(opt.token, opt);
  }
}

/** Internal slug → upstream NSID token for the record, or null if unknown. */
export function tokenForSlug(dim: VocabDimension, slug: string | null | undefined): string | null {
  if (!slug) return null;
  return BY_SLUG[dim].get(slug)?.token ?? null;
}

/** Upstream NSID token → internal slug (for import prefill), or null if unknown. */
export function slugForToken(dim: VocabDimension, token: string | null | undefined): string | null {
  if (!token) return null;
  return BY_TOKEN[dim].get(token)?.slug ?? null;
}

/** Display label for a slug (used in the search document, weight B). */
export function labelForSlug(dim: VocabDimension, slug: string | null | undefined): string | null {
  if (!slug) return null;
  return BY_SLUG[dim].get(slug)?.label ?? null;
}
