/**
 * Curated tag seed map for the Open Food Facts taxonomy (plan §4.1, extended).
 *
 * §4.1's own sketch only asks for `{vg, vt, al}`. §8.2's diet classifier needs
 * more than that literal shape can answer: halal and kosher need to know
 * **pork** and **alcohol**, pescatarian needs to tell **meat** from **fish**,
 * and kosher needs meat/dairy co-occurrence. Hand-listing every pork product
 * inside the classifier would duplicate the ancestor walk `traits.json`
 * already does, so instead this is one more curated map, folded through
 * `ancestorUnion` exactly like `food-allergens.ts`'s `FOOD_ALLERGEN_MAP`: seed
 * the roots (`en:pork`, `en:meat`, `en:wine`, …) and inheritance reaches
 * every descendant for free — `en:pork-shoulder`, `en:minced-pork`,
 * `en:mechanically-separated-meat-of-pork`, and hundreds like them, without a
 * line here for any of them.
 *
 * Every key must be a real taxonomy id — the build script fails loudly (the
 * same `orphans` check `FOOD_AISLE_MAP` goes through) on one that doesn't
 * resolve.
 */

import type { FoodTag } from "../packages/food/src/traits.ts";

export const FOOD_TAG_MAP: Record<string, readonly FoodTag[]> = {
  // pork (also meat)
  "en:pork": ["meat", "pork"],
  // `en:bacon` and `en:ham` already carry "prosciutto" and "pancetta" as
  // *synonyms* in the taxonomy (Italian-language lines on those same blocks)
  // rather than as separate nodes, so they need no entries of their own here.
  "en:bacon": ["meat", "pork"],
  "en:ham": ["meat", "pork"],
  "en:lard": ["pork"],
  "en:chorizo": ["meat", "pork"],
  "en:salami": ["meat", "pork"],
  "en:pepperoni": ["meat", "pork"],

  // other meat
  "en:meat": ["meat"],
  "en:poultry": ["meat"],
  "en:chicken": ["meat"],
  "en:turkey": ["meat"],
  "en:duck": ["meat"],
  "en:beef": ["meat"],
  "en:veal": ["meat"],
  "en:lamb": ["meat"],
  "en:game-animal": ["meat"],
  "en:sausage": ["meat"],
  "en:gelatin": ["meat"],

  // seafood — distinct from "meat" for pescatarian
  "en:fish": ["seafood"],
  "en:shellfish": ["seafood"],
  "en:crustacean": ["seafood"],

  // alcohol
  "en:wine": ["alcohol"],
  "en:beer": ["alcohol"],
  "en:alcohol": ["alcohol"],
  "en:liqueur": ["alcohol"],
  "en:rum": ["alcohol"],
  "en:whisky": ["alcohol"],
  "en:vodka": ["alcohol"],
  "en:sake": ["alcohol"],
  "en:brandy": ["alcohol"],
  "en:cider": ["alcohol"],
};
