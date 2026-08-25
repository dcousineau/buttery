/**
 * Hand-authored aisle assignments for Open Food Facts taxonomy nodes.
 *
 * This is the only hand-maintained half of the food lexicon. It maps roughly a
 * hundred *nodes* — not foods — and `scripts/build-food-lexicon.ts` resolves the
 * other ~4,600 entries by walking each food's ancestors and taking the nearest
 * mapped one. So `en:chicken-breast` is never listed here: it inherits
 * `meat_seafood` through `en:chicken-meat` → `en:poultry`.
 *
 * Ordering inside this file does not matter; specificity does. A deeper node
 * always wins over a shallower one, which is how `en:salt` lands in `spices`
 * without dragging every mineral with it.
 *
 * Every key must be a real taxonomy id — the build script fails loudly on ids
 * that no longer resolve, so a taxonomy refresh cannot silently drop a mapping.
 */

import type { Aisle } from "../packages/food/src/aisles.ts";

export const FOOD_AISLE_MAP: Record<string, Aisle> = {
  // ---------------------------------------------------------------- produce
  "en:vegetable": "produce",
  "en:fruit": "produce",
  "en:citrus-fruit": "produce",
  "en:dried-fruit": "snacks",
  "en:mushroom": "produce",
  "en:salad": "produce",
  "en:herb": "produce",
  "en:potato": "produce",
  "en:onion": "produce",
  "en:garlic": "produce",
  "en:tomato": "produce",
  "en:leek": "produce",
  "en:celery": "produce",
  "en:spinach": "produce",
  "en:lettuce": "produce",
  "en:cabbage": "produce",
  "en:broccoli": "produce",
  "en:cucumber": "produce",
  "en:avocado": "produce",
  "en:bell-pepper": "produce",
  "en:carrot": "produce",
  "en:apple": "produce",
  "en:banana": "produce",
  "en:lemon": "produce",
  "en:lime": "produce",
  "en:algae": "produce",

  // ----------------------------------------------------------- meat_seafood
  "en:meat": "meat_seafood",
  "en:poultry": "meat_seafood",
  "en:game-animal": "meat_seafood",
  "en:beef": "meat_seafood",
  "en:pork": "meat_seafood",
  "en:lamb": "meat_seafood",
  "en:veal": "meat_seafood",
  "en:chicken": "meat_seafood",
  "en:turkey": "meat_seafood",
  "en:duck": "meat_seafood",
  "en:fish": "meat_seafood",
  "en:shellfish": "meat_seafood",
  "en:salmon": "meat_seafood",
  "en:tuna": "meat_seafood",
  "en:cod": "meat_seafood",
  "en:shrimp": "meat_seafood",
  "en:crab": "meat_seafood",
  "en:oyster": "meat_seafood",
  "en:gelatin": "baking",

  // ------------------------------------------------------------------- deli
  // Cured and cooked meats are bought at a different counter than raw ones,
  // so they override the `en:meat` / `en:pork` mappings above.
  "en:ham": "deli",
  "en:bacon": "deli",
  "en:sausage": "deli",

  // ------------------------------------------------------------- dairy_eggs
  "en:dairy": "dairy_eggs",
  "en:milk": "dairy_eggs",
  "en:cheese": "dairy_eggs",
  "en:butter": "dairy_eggs",
  "en:cream": "dairy_eggs",
  "en:sour-cream": "dairy_eggs",
  "en:heavy-cream": "dairy_eggs",
  "en:buttermilk": "dairy_eggs",
  "en:yogurt": "dairy_eggs",
  "en:cheddar": "dairy_eggs",
  "en:mozzarella": "dairy_eggs",
  "en:parmigiano-reggiano": "dairy_eggs",
  "en:egg": "dairy_eggs",
  "en:margarine": "dairy_eggs",
  "en:tofu": "dairy_eggs",
  "en:soy-milk": "dairy_eggs",

  // ----------------------------------------------------------------- bakery
  "en:bread": "bakery",
  "en:dough": "bakery",
  "en:cake": "bakery",
  "en:pastry": "bakery",
  "en:tortilla": "bakery",

  // ----------------------------------------------------------------- frozen
  "en:ice-cream": "frozen",

  // ---------------------------------------------------------- canned_jarred
  "en:jam": "canned_jarred",
  "en:olive": "canned_jarred",
  "en:broth": "canned_jarred",
  "en:fond": "canned_jarred",
  "en:coconut-milk": "canned_jarred",
  "en:tomato-sauce": "canned_jarred",
  "en:puree": "canned_jarred",

  // -------------------------------------------------------------- dry_goods
  "en:cereal": "dry_goods",
  "en:rice": "dry_goods",
  "en:pasta": "dry_goods",
  "en:noodle": "dry_goods",
  "en:couscous": "dry_goods",
  "en:barley": "dry_goods",
  "en:oat": "dry_goods",
  "en:quinoa": "dry_goods",
  "en:legume": "dry_goods",
  "en:beans": "dry_goods",
  "en:lentils": "dry_goods",
  "en:chickpea": "dry_goods",
  "en:corn": "dry_goods",
  "en:pea": "dry_goods",

  // ----------------------------------------------------------------- pantry
  "en:oil-and-fat": "pantry",
  "en:vegetable-oil": "pantry",
  "en:olive-oil": "pantry",
  "en:sunflower-oil": "pantry",
  "en:vinegar": "pantry",
  "en:sauce": "pantry",
  "en:soy-sauce": "pantry",
  "en:condiment": "pantry",
  "en:mustard": "pantry",
  "en:mayonnaise": "pantry",
  "en:ketchup": "pantry",
  "en:honey": "pantry",
  "en:syrup": "pantry",
  "en:peanut": "snacks",

  // ----------------------------------------------------------------- spices
  "en:spice": "spices",
  "en:salt": "spices",
  "en:sea-salt": "spices",
  "en:pepper": "spices",
  "en:black-pepper": "spices",
  "en:chili-pepper": "spices",
  "en:cinnamon": "spices",
  "en:cumin": "spices",
  "en:paprika": "spices",
  "en:turmeric": "spices",
  "en:nutmeg": "spices",
  "en:bay-leaf": "spices",
  "en:ginger": "spices",
  "en:basil": "spices",
  "en:parsley": "produce",
  "en:thyme": "spices",
  "en:rosemary": "spices",
  "en:oregano": "spices",
  "en:flavouring": "spices",
  "en:essential-oil": "spices",

  // ----------------------------------------------------------------- baking
  "en:flour": "baking",
  "en:wheat": "baking",
  "en:added-sugar": "baking",
  "en:sugar": "baking",
  "en:baking-powder": "baking",
  "en:yeast": "baking",
  "en:starch": "baking",
  "en:corn-starch": "baking",
  "en:modified-starch": "baking",
  "en:chocolate": "baking",
  "en:cocoa": "baking",
  "en:vanilla": "baking",
  "en:vanilla-extract": "baking",
  "en:almond": "baking",
  "en:walnut": "baking",
  "en:coating": "baking",
  "en:filling": "baking",

  // -------------------------------------------------------------- beverages
  "en:water": "beverages",
  "en:coffee": "beverages",
  "en:tea": "beverages",
  "en:juice": "beverages",
  "en:alcohol": "beverages",
  "en:wine": "beverages",
  "en:beer": "beverages",

  // ----------------------------------------------------------------- snacks
  "en:nut": "snacks",
  "en:seed": "snacks",
  "en:biscuit": "snacks",
  "en:wafer": "snacks",
};
