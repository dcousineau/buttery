/**
 * The synonym pass (plan §9).
 *
 * Open Food Facts' ingredients taxonomy is built for reading **product labels**,
 * not recipes. That shows: it has `en:wheat-flour` but nothing anyone would type
 * as "all-purpose flour", and it carries `en:raising-agent` while never naming
 * baking soda at all. Calibration against the real recipe corpus turns those
 * gaps into this file.
 *
 * Two mechanisms, in preference order:
 *
 * 1. {@link EXTRA_SYNONYMS} attaches more English names to a taxonomy node that
 *    already exists. Always prefer this — it keeps the Open Food Facts id as the
 *    food identity, exactly as plan D6 requires.
 *
 * 2. {@link EXTRA_FOODS} mints a food for something the taxonomy genuinely does
 *    not have. This is a **deliberate, documented deviation from D6**, kept as
 *    small as it can be. The ids are namespaced `buttery:` so they can never
 *    collide with an Open Food Facts id, and so a future taxonomy refresh that
 *    adds the real node is a one-line swap. Everything else about them behaves
 *    like a taxonomy food: they merge, they carry an aisle, they can be staples.
 */

import type { Aisle } from "../services/web/src/lib/grocery/aisles.ts";

/** Extra English names for nodes the taxonomy already has. Keys must resolve. */
export const EXTRA_SYNONYMS: Record<string, string[]> = {
  "en:wheat-flour": ["all purpose flour", "all-purpose flour", "plain flour", "ap flour", "white flour"],
  "en:whole-wheat-flour": ["wholewheat flour", "whole meal flour"],
  "en:sugar": ["white sugar", "granulated sugar", "caster sugar", "castor sugar"],
  "en:brown-sugar": ["light brown sugar", "dark brown sugar", "packed brown sugar"],
  "en:icing-sugar": ["powdered sugar", "confectioners sugar", "confectioner's sugar"],
  "en:salt": ["table salt", "fine salt", "salt to taste"],
  "en:black-pepper": ["freshly ground black pepper", "ground black pepper", "cracked black pepper", "pepper to taste"],
  "en:olive-oil": ["extra virgin olive oil", "evoo"],
  "en:heavy-cream": ["heavy whipping cream", "double cream", "whipping cream"],
  "en:sour-cream": ["soured cream"],
  "en:spring-onion": ["scallion", "scallions", "green onion", "green onions"],
  "en:coriander-leaf": ["cilantro", "fresh cilantro", "coriander leaves"],
  "en:courgette": ["zucchini", "zucchinis", "courgettes"],
  "en:aubergine": ["eggplant", "eggplants"],
  "en:chickpea": ["garbanzo bean", "garbanzo beans", "chick peas"],
  "en:coriander-seed": ["ground coriander"],
  "en:tomato-puree": ["tomato paste", "tomato concentrate"],
  "en:peeled-tomatoes": ["crushed tomatoes", "diced tomatoes", "chopped tomatoes", "tinned tomatoes", "canned tomatoes"],
  "en:broth": ["chicken broth", "vegetable broth", "beef broth", "chicken stock", "vegetable stock", "beef stock"],
  "en:cream-cheese": ["softened cream cheese"],
  "en:kosher-salt": ["coarse kosher salt"],
  "en:parmigiano-reggiano": ["parmesan", "parmesan cheese", "grated parmesan"],
  "en:beef": ["ground beef", "minced beef", "beef mince"],
  "en:pork": ["ground pork", "minced pork"],
  "en:turkey": ["ground turkey"],
  "en:chicken-breast": ["boneless skinless chicken breast", "chicken breasts"],
  "en:chicken-thigh": ["boneless skinless chicken thigh", "chicken thighs"],
  "en:butter": ["unsalted butter", "salted butter", "melted butter", "softened butter"],
  "en:vanilla-extract": ["pure vanilla extract", "vanilla essence"],
  "en:lemon-juice": ["fresh lemon juice", "juice of a lemon"],
  "en:lime-juice": ["fresh lime juice", "juice of a lime"],
  "en:garlic": ["garlic clove", "garlic cloves", "cloves garlic", "minced garlic"],
  "en:ginger": ["fresh ginger", "ginger root", "grated ginger"],
  "en:soy-sauce": ["light soy sauce", "dark soy sauce", "shoyu"],
  "en:yogurt": ["greek yogurt", "plain yogurt", "yoghurt", "greek yoghurt"],
  "en:mozzarella": ["fresh mozzarella", "shredded mozzarella"],
  "en:cheddar": ["sharp cheddar", "shredded cheddar", "grated cheddar"],
  "en:breadcrumbs": ["bread crumbs", "panko", "panko breadcrumbs"],
  "en:oat": ["rolled oats", "old fashioned oats", "quick oats"],
  "en:honey": ["raw honey"],
  "en:maple-syrup": ["pure maple syrup"],
  "en:peanut-butter": ["creamy peanut butter", "crunchy peanut butter"],
  "en:egg": ["large egg", "large eggs", "eggs"],
  "en:milk": ["whole milk", "skim milk", "2% milk"],

  // Closing the gaps the calibration sweep surfaced against the real corpus.
  "en:beef-steak": ["flank steak", "skirt steak", "sirloin steak", "steak"],
  "en:chili-pepper": ["chile", "chiles", "chilli", "red pepper flakes", "crushed red pepper", "jalapeno", "jalapenos", "serrano", "poblano", "habanero"],
  "en:pasta": ["bucatini", "ziti", "rigatoni", "penne", "fusilli", "orecchiette", "linguine", "tagliatelle"],
  "en:bacon": ["guanciale", "pancetta", "lardons"],
};

/**
 * Foods the taxonomy has no node for at all. See the module doc: this is the
 * documented D6 exception, and it stays short on purpose.
 */
export const EXTRA_FOODS: Record<string, { names: string[]; aisle: Aisle; staple?: boolean }> = {
  "buttery:baking-soda": {
    names: ["baking soda", "bicarbonate of soda", "sodium bicarbonate", "bicarb"],
    aisle: "baking",
    staple: true,
  },
  "buttery:cooking-spray": {
    names: ["cooking spray", "nonstick cooking spray", "non-stick spray"],
    aisle: "pantry",
    staple: true,
  },
  "buttery:amchur": {
    names: ["amchur", "amchoor", "dried mango powder", "mango powder"],
    aisle: "spices",
    staple: true,
  },
  "buttery:chili-crisp": {
    names: ["chili crisp", "chile crisp", "chilli crisp"],
    aisle: "pantry",
  },
  "buttery:half-and-half": {
    names: ["half and half", "half-and-half"],
    aisle: "dairy_eggs",
  },
};
