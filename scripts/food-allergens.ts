/**
 * Curated allergen maps for the Open Food Facts taxonomy (plan §4.1).
 *
 * Two maps, two different key spaces:
 *
 * - `OFF_ALLERGEN_MAP` translates the taxonomy's OWN `allergens:en:` property
 *   values — tokens from OFF's separate `allergens.txt` taxonomy, not
 *   ingredient node ids — onto Buttery's ten allergen slugs. Only 74 lines in
 *   the whole ingredients taxonomy carry that property (mostly additives), so
 *   this map alone reaches almost nothing.
 * - `FOOD_ALLERGEN_MAP` is what actually gives the derived data its reach: a
 *   hand-picked set of ingredient *node* ids, resolved by
 *   `scripts/build-food-lexicon.ts` via `ancestorUnion` — every mapped
 *   ancestor's allergens fold together, not just the nearest one. This is the
 *   same shape as `food-aisle-map.ts`: map roughly a hundred nodes and let
 *   inheritance cover the other thousands. `en:fish` itself carries no
 *   `allergens:en:` property at all, which is exactly why a seed map on top of
 *   the taxonomy property is still required.
 *
 * Every key in `FOOD_ALLERGEN_MAP` must be a real taxonomy id — the build
 * script fails loudly (via the same `orphans` check `FOOD_AISLE_MAP` goes
 * through) on an id that no longer resolves.
 */

import type { AllergenSlug } from "../packages/food/src/traits.ts";

/**
 * OFF allergen-taxonomy token → Buttery allergen slug(s), as seen in the
 * pinned taxonomy's `allergens:en:` values.
 *
 * `en:celery`, `en:mustard`, `en:molluscs` and `en:lupin` are EU-declarable
 * allergens the taxonomy tags, but none of Buttery's ten slugs cover them —
 * on purpose. D7 pins the FDA Big 9 plus gluten, not the EU's fourteen, so
 * these three map to nothing: the omission is deliberate, not missed.
 */
export const OFF_ALLERGEN_MAP: Record<string, readonly AllergenSlug[]> = {
  "en:gluten": ["gluten"],
  "en:soybeans": ["soy"],
  "en:milk": ["milk"],
  "en:fish": ["fish"],
  "en:sesame-seeds": ["sesame"],
  "en:eggs": ["egg"],
  "en:peanuts": ["peanut"],
  "en:nuts": ["tree_nuts"],
  "en:crustaceans": ["crustacean_shellfish"],
  // Declared but not one of Buttery's ten slugs — see the doc comment above.
  "en:celery": [],
  "en:mustard": [],
  "en:molluscs": [],
  "en:lupin": [],
};

/**
 * Curated ingredient-node seed. `ancestorUnion` walks every node's whole
 * ancestor closure and folds every mapped ancestor's allergens together — a
 * descendant with two differently-allergenic parents inherits both.
 * `en:soy-and-sesame-sauce`, for one real example, is not listed here at all:
 * it picks up `sesame` from one parent and `soy`/`wheat`/`gluten` from
 * another, purely from this map plus the ancestor walk.
 */
export const FOOD_ALLERGEN_MAP: Record<string, readonly AllergenSlug[]> = {
  // dairy
  "en:milk": ["milk"],
  "en:cheese": ["milk"],
  "en:cream": ["milk"],
  "en:butter": ["milk"],
  "en:yogurt": ["milk"],
  "en:buttermilk": ["milk"],
  "en:whey": ["milk"],
  "en:casein": ["milk"],
  "en:lactose": ["milk"],
  "en:milk-powder": ["milk"],

  // egg
  "en:egg": ["egg"],

  // fish and shellfish
  "en:fish": ["fish"],
  "en:fish-sauce": ["fish"],
  "en:anchovy": ["fish"],
  "en:shellfish": ["crustacean_shellfish"],
  "en:crustacean": ["crustacean_shellfish"],
  "en:shrimp": ["crustacean_shellfish"],
  "en:crab": ["crustacean_shellfish"],
  "en:lobster": ["crustacean_shellfish"],

  // tree nuts
  "en:tree-nut": ["tree_nuts"],
  "en:almond": ["tree_nuts"],
  "en:walnut": ["tree_nuts"],
  "en:cashew-nuts": ["tree_nuts"],
  "en:pistachio-nuts": ["tree_nuts"],
  "en:hazelnut": ["tree_nuts"],
  "en:pecan-nut": ["tree_nuts"],
  "en:macadamia-nut": ["tree_nuts"],
  "en:brazil-nut": ["tree_nuts"],
  "en:chestnut": ["tree_nuts"],
  "en:pine-nuts": ["tree_nuts"],
  "en:coconut": ["tree_nuts"],

  // peanut
  "en:peanut": ["peanut"],
  "en:peanut-butter": ["peanut"],

  // gluten-bearing grains — wheat and gluten are distinct (barley/rye are
  // gluten but not wheat)
  "en:wheat": ["wheat", "gluten"],
  "en:barley": ["gluten"],
  "en:rye": ["gluten"],
  "en:malt": ["gluten"],

  // soy
  "en:soya-bean": ["soy"],
  "en:soy-sauce": ["soy", "wheat", "gluten"],
  "en:tofu": ["soy"],
  "en:soy-milk": ["soy"],
  "en:miso": ["soy"],
  "en:edamame": ["soy"],

  // sesame
  "en:sesame-seeds": ["sesame"],
  "en:sesame-oil": ["sesame"],
  "en:tahini": ["sesame"],
};
