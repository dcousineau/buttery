/**
 * Fill the LOCAL dev database with a realistic recipe corpus, so the grocery-list
 * feature has something honest to be exercised and calibrated against.
 *
 *   node scripts/seed-dev-recipes.ts
 *
 * Dev-only. It is never imported by the app, never runs in CI, and never touches
 * a database it was not pointed at by `services/web/.env`.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * The grocery list is built by parsing `recipe_ingredient.text` — free text a
 * human wrote — into a food, a quantity and a unit, then consolidating across
 * recipes. Every interesting failure of that parse lives in the phrasing: a size
 * in parentheses (`1 (14.5 oz) can`), a vulgar fraction (`1½`), a range (`2 to 3
 * cups`), a unit that does not convert (`4 cloves`), a metric restatement of an
 * imperial amount (`2 sticks unsalted butter 226 grams`), a line that is not an
 * ingredient at all (`For serving:`). A hand-tidied corpus hides all of it and
 * calibrates the matcher against a world that does not exist. So:
 *
 *   1. The five committed Paprika fixtures are read at run time, verbatim. They
 *      are real files from a real 341-recipe export; their weirdness is not
 *      invented and must not be edited.
 *   2. `SEED_RECIPES` below adds ~two dozen more, hand-written to spread across
 *      everyday home cooking (roasts, stir fries, soups, salads, baking, pasta,
 *      curries, breakfasts, tacos) and to vary units and phrasing deliberately.
 *
 * Several foods recur ACROSS recipes in DIFFERENT units on purpose — chicken
 * breast in pounds, ounces and grams; garlic as cloves, as a minced tablespoon
 * and as a whole head; butter in sticks, tablespoons and grams; tomatoes in
 * three different can sizes. Consolidation that has nothing to merge proves
 * nothing, and a corpus where every "2 cloves garlic" is spelled identically
 * would make the matcher look far better than it is.
 *
 * ── WHY IT DOES NOT CALL `parsePaprikaRecipe` ────────────────────────────────
 *
 * It would like to. It cannot: this file runs under plain `node` type stripping,
 * and `@buttery/recipe-extract/paprika` reaches `export.ts` / `entry-source.ts`,
 * both of which declare TypeScript *parameter properties*
 * (`constructor(public readonly code: …)`). Strip-only mode rejects those with
 * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX, and Node 26 has removed the
 * `--experimental-transform-types` escape hatch. So the fixtures go through the
 * two pieces the importer itself leans on for the fields we need — the shared
 * `readItem` + `schemaOrgToLexicon` crosswalk for ingredients (§4.1 note 2) and
 * a one-`<p>`-per-step read of `recipeInstructions` (§4.1 note 1) — which are
 * plain functions and load fine. Nothing here re-implements a parser; if the
 * package ever drops parameter properties, these ten lines collapse into one
 * `parsePaprikaRecipe` call.
 *
 * ── WHY THE IMPORTS LOOK LIKE THAT ───────────────────────────────────────────
 *
 * `scripts/` is not a workspace package, so it has no `node_modules` of its own
 * and cannot resolve `kysely`, `pg` or `node-html-parser` by name. They are
 * reached through the package that DOES depend on them. Two of the three also
 * ship their types somewhere Node's runtime specifier cannot point at (`pg`
 * types live in `@types/pg`; node-html-parser's `.d.ts` does not pair with its
 * `.mjs`), which is why those two are a `import type` + `await import()` pair:
 * the type side and the runtime side genuinely need different specifiers, and
 * type-aware oxlint reports every one of them as `error`-typed otherwise.
 *
 * ── IDEMPOTENCE ──────────────────────────────────────────────────────────────
 *
 * Every row this script writes is keyed by a deterministic `seed-<slug>` recipe
 * id. It reads nothing else and it modifies nothing else — a recipe you imported
 * yourself is invisible to it.
 *
 * Re-running UPSERTS the `recipe` row rather than deleting and re-inserting it,
 * which is not the obvious shape and is deliberate: `meal_plan_entry.recipe_id`
 * is ON DELETE RESTRICT and `grocery_item_source.recipe_id` is ON DELETE SET
 * NULL. Delete-then-insert would therefore explode the moment a seeded recipe
 * were on a meal plan, and would silently strip the provenance from any grocery
 * item already built from one — i.e. it would break exactly the workflow this
 * corpus exists to support. The ingredient and instruction rows have no inbound
 * foreign keys, so those are replaced wholesale and the ordinals stay dense.
 */

import type * as NodeHtmlParser from "../packages/recipe-extract/node_modules/node-html-parser/dist/index.d.ts";
import type * as Pg from "../services/web/node_modules/@types/pg/index.d.ts";
import { Kysely, PostgresDialect } from "../services/web/node_modules/kysely/dist/index.js";
import { readItem } from "../packages/recipe-extract/src/parse/microdata.ts";
import { schemaOrgToLexicon } from "../packages/recipe-schemas/src/bridge/index.ts";
import type { DB } from "../services/web/src/db/types.ts";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = join(ROOT, "packages/recipe-extract/src/paprika/__fixtures__");
const ENV_FILE = join(ROOT, "services/web/.env");

/** Every recipe id this script owns starts with this. It is also the delete key,
 *  so it must never be a prefix a human-created recipe could plausibly carry.
 *  Recipe ids are atproto rkeys, where `-` is legal, so this is a valid id and
 *  not a shape the app has to special-case (see AGENTS.md). */
const ID_PREFIX = "seed-";

/** The shape both halves of the corpus collapse into before they hit the DB. */
interface SeedRecipe {
  /** `seed-<slug>` — stable across runs, which is the whole idempotence story. */
  id: string;
  name: string;
  recipeYield: string | null;
  /** ISO-8601 duration, exactly as the `recipe` table stores it (lossless). */
  totalTime: string | null;
  ingredients: string[];
  instructions: string[];
}

// ---------------------------------------------------------------------------
// The hand-written corpus
// ---------------------------------------------------------------------------

/**
 * ~two dozen everyday recipes, written the way recipes are actually written.
 *
 * Rules held to while writing these, because they are what makes the corpus
 * worth calibrating against rather than a list of nouns:
 *
 *   - quantities are messy: `1½`, `1 1/2`, `2 to 3`, `Juice of 1 lemon`, none;
 *   - units are inconsistent between recipes on purpose (lb / oz / g / kg,
 *     cup / ml, tbsp / tablespoon / T);
 *   - preparation rides along in the same string (`, finely minced`, `, drained
 *     and rinsed`, `, at room temperature`);
 *   - non-food lines exist (`Kosher salt and freshly ground black pepper, to
 *     taste`, section headers) because real recipes have them;
 *   - the same food appears in several recipes under different units and
 *     different spellings, so consolidation has real work to do.
 *
 * `minutes` is a convenience: the DB wants both the ISO string and its seconds.
 */
const SEED_RECIPES: readonly { slug: string; name: string; yield: string; minutes: number; ingredients: readonly string[]; instructions: readonly string[] }[] = [
  // ── Roasts ────────────────────────────────────────────────────────────────
  {
    slug: "sunday-roast-chicken",
    name: "Sunday Roast Chicken with Root Vegetables",
    yield: "Serves 4 to 6",
    minutes: 105,
    ingredients: [
      "1 whole chicken (3 1/2 to 4 lbs), giblets removed",
      "3 tbsp extra-virgin olive oil",
      "1 whole head of garlic, halved crosswise",
      "1 lemon, halved",
      "4 sprigs fresh thyme",
      "2 sprigs fresh rosemary",
      "1 1/2 lbs Yukon Gold potatoes, cut into 1-inch chunks",
      "3 large carrots, peeled and cut into 2-inch batons",
      "2 medium yellow onions, cut into thick wedges",
      "2 tbsp unsalted butter, softened",
      "Kosher salt and freshly ground black pepper, to taste",
    ],
    instructions: [
      "Heat the oven to 425°F. Pat the chicken dry inside and out and season it generously all over, including inside the cavity.",
      "Stuff the cavity with the lemon halves, half the garlic head, the thyme and the rosemary. Rub the softened butter under the skin of the breast.",
      "Toss the potatoes, carrots and onions with the olive oil and the remaining garlic in a large roasting pan. Season, then set the chicken on top.",
      "Roast for 1 hour 15 minutes, tossing the vegetables once at the halfway mark, until a thermometer in the thigh reads 165°F.",
      "Rest the chicken 15 minutes before carving. Spoon the pan juices over everything.",
    ],
  },
  {
    slug: "garlic-rosemary-pork-loin",
    name: "Garlic-Rosemary Pork Loin Roast",
    yield: "8 servings",
    minutes: 90,
    ingredients: [
      "1 boneless pork loin roast, about 3 lbs",
      "6 cloves garlic, finely minced",
      "2 tablespoons fresh rosemary, chopped",
      "1 tablespoon Dijon mustard",
      "60 ml extra-virgin olive oil",
      "2 tsp kosher salt",
      "1 tsp freshly ground black pepper",
      "1 cup low-sodium chicken broth",
      "1/2 cup dry white wine",
      "2 tablespoons all-purpose flour",
    ],
    instructions: [
      "Whisk the garlic, rosemary, mustard, olive oil, salt and pepper into a paste and rub it over the entire roast. Let it sit at room temperature for 45 minutes.",
      "Heat the oven to 400°F. Sear the roast in an oven-safe skillet over medium-high heat until browned on all sides, about 8 minutes total.",
      "Transfer the skillet to the oven and roast until the center reads 145°F, 50 to 60 minutes. Move the pork to a board and tent with foil.",
      "Whisk the flour into the pan drippings, add the wine and broth, and simmer until the gravy coats a spoon. Slice the pork and serve with the gravy.",
    ],
  },
  {
    slug: "slow-roasted-chuck",
    name: "Slow-Roasted Beef Chuck with Onion Gravy",
    yield: "Serves 6",
    minutes: 240,
    ingredients: [
      "3 to 4 pounds boneless beef chuck roast",
      "2 tbsp vegetable oil",
      "3 large yellow onions, thinly sliced",
      "4 cloves garlic, smashed",
      "2 tablespoons tomato paste",
      "2 cups beef stock",
      "1 cup dry red wine",
      "3 sprigs fresh thyme",
      "2 bay leaves",
      "2 tablespoons Worcestershire sauce",
      "Kosher salt and freshly ground black pepper, to taste",
    ],
    instructions: [
      "Season the chuck heavily and let it sit uncovered in the refrigerator overnight if you have the time.",
      "Heat the oven to 300°F. Brown the roast in the oil in a Dutch oven, then set it aside.",
      "Cook the onions in the same pot until deeply golden, 20 minutes. Stir in the garlic and tomato paste and cook 2 minutes more.",
      "Add the wine, scrape the bottom of the pot, then add the stock, thyme, bay leaves and Worcestershire. Return the beef, cover, and braise 3 to 3 1/2 hours until it shreds.",
      "Skim the fat, discard the bay leaves, and reduce the gravy on the stovetop if it is thin.",
    ],
  },

  // ── Stir fries ────────────────────────────────────────────────────────────
  {
    slug: "ginger-scallion-chicken-stir-fry",
    name: "Ginger Scallion Chicken Stir-Fry",
    yield: "4 servings",
    minutes: 30,
    ingredients: [
      "2 lbs boneless, skinless chicken thighs, cut into bite-size pieces",
      "2 tablespoons cornstarch",
      "3 tablespoons soy sauce, divided",
      "1 tablespoon Shaoxing wine",
      "1 (2-inch) piece fresh ginger, peeled and grated",
      "6 scallions, whites and greens separated, cut into 1-inch lengths",
      "4 cloves garlic, thinly sliced",
      "2 tbsp neutral oil, such as grapeseed",
      "1 tablespoon toasted sesame oil",
      "1 teaspoon sugar",
      "Steamed jasmine rice, for serving",
    ],
    instructions: [
      "Toss the chicken with the cornstarch, 1 tablespoon of the soy sauce and the Shaoxing wine. Let it marinate 15 minutes.",
      "Heat a wok or wide skillet over the highest heat until smoking. Add the neutral oil and sear the chicken in a single layer, undisturbed, for 2 minutes, then stir-fry until cooked through.",
      "Add the ginger, garlic and scallion whites and stir-fry 30 seconds, until fragrant but not browned.",
      "Add the remaining soy sauce, the sugar and the sesame oil, toss once, then kill the heat and fold in the scallion greens. Serve over rice.",
    ],
  },
  {
    slug: "beef-and-broccoli",
    name: "Beef and Broccoli Stir-Fry",
    yield: "Serves 4",
    minutes: 35,
    ingredients: [
      "1 1/4 lbs flank steak, sliced thin against the grain",
      "1 lb broccoli crowns, cut into florets",
      "3 cloves garlic, finely minced",
      "1 tablespoon finely grated fresh ginger",
      "1/4 cup oyster sauce",
      "2 tablespoons low-sodium soy sauce",
      "1 tbsp cornstarch dissolved in 3 tbsp cold water",
      "2 tablespoons neutral oil",
      "1 teaspoon sugar",
      "1/2 cup water",
      "Kosher salt and freshly ground black pepper, to taste",
    ],
    instructions: [
      "Whisk the oyster sauce, soy sauce and sugar together and set the slurry beside the stove.",
      "Steam or blanch the broccoli for 2 minutes, until bright green and barely tender. Drain well.",
      "Sear the beef in the oil over very high heat in two batches so it browns rather than steams. Remove it to a plate.",
      "Stir-fry the garlic and ginger for 20 seconds, add the sauce and the water, then return the beef and broccoli. Stir in the cornstarch slurry and toss until glossy.",
    ],
  },
  {
    slug: "tofu-snow-pea-stir-fry",
    name: "Crispy Tofu and Snow Pea Stir-Fry",
    yield: "3 to 4 servings",
    minutes: 40,
    ingredients: [
      "14 oz extra-firm tofu, pressed and cut into 3/4-inch cubes",
      "3 tablespoons cornstarch",
      "8 ounces snow peas, strings removed",
      "1 red bell pepper, sliced into thin strips",
      "3 cloves garlic, finely minced",
      "1 tbsp finely grated fresh ginger",
      "3 tablespoons soy sauce",
      "1 tablespoon rice vinegar",
      "2 teaspoons chili crisp, or to taste",
      "1/4 cup neutral oil",
      "2 scallions, thinly sliced",
    ],
    instructions: [
      "Toss the tofu with the cornstarch until every face is dusty. Fry it in the oil, turning every couple of minutes, until deeply golden. Drain on paper towels.",
      "Pour off all but 1 tablespoon of oil. Stir-fry the bell pepper for 2 minutes, then the snow peas for 1 minute more.",
      "Add the garlic and ginger, then the soy sauce, vinegar and chili crisp. Return the tofu and toss just long enough to coat — any longer and the crust softens.",
      "Finish with the scallions.",
    ],
  },

  // ── Soups ─────────────────────────────────────────────────────────────────
  {
    slug: "weeknight-chicken-noodle-soup",
    name: "Weeknight Chicken Noodle Soup",
    yield: "6 servings",
    minutes: 45,
    ingredients: [
      "12 ounces boneless, skinless chicken breast",
      "1 quart low-sodium chicken broth",
      "2 cups water",
      "2 tbsp unsalted butter",
      "1 large yellow onion, diced",
      "3 large carrots, peeled and sliced into coins",
      "3 stalks celery, sliced",
      "3 cloves garlic, finely minced",
      "6 oz wide egg noodles",
      "2 tablespoons chopped fresh dill",
      "Juice of 1/2 lemon",
      "Kosher salt and freshly ground black pepper, to taste",
    ],
    instructions: [
      "Melt the butter in a heavy pot and sweat the onion, carrots and celery with a big pinch of salt until softened, about 8 minutes. Add the garlic for the last minute.",
      "Add the broth and water, bring to a bare simmer, and poach the chicken breasts until cooked through, 12 to 15 minutes. Remove and shred them.",
      "Bring the broth back to a boil and cook the noodles directly in it until just tender.",
      "Return the chicken, then finish off the heat with the dill and lemon juice. Season aggressively — soup needs more salt than you think.",
    ],
  },
  {
    slug: "creamy-tomato-soup",
    name: "Creamy Tomato Soup",
    yield: "Serves 4",
    minutes: 40,
    ingredients: [
      "2 (28 ounce) cans whole peeled San Marzano tomatoes",
      "4 tablespoons (1/2 stick) unsalted butter",
      "1 large yellow onion, thinly sliced",
      "4 cloves garlic, smashed",
      "1 tablespoon tomato paste",
      "1/2 cup heavy cream",
      "1 tsp sugar, or to taste",
      "1/4 cup torn fresh basil leaves",
      "Kosher salt and freshly ground black pepper, to taste",
      "Grilled cheese sandwiches, for serving",
    ],
    instructions: [
      "Melt the butter and cook the onion slowly until sweet and translucent, 12 minutes. Add the garlic and tomato paste and cook until the paste darkens.",
      "Add both cans of tomatoes with their juice, crushing them by hand as they go in. Simmer 20 minutes.",
      "Blend until smooth — an immersion blender is easiest — then stir in the cream and the sugar. Season and finish with the basil.",
    ],
  },
  {
    slug: "red-lentil-soup",
    name: "Red Lentil Soup with Lemon",
    yield: "4 to 6 servings",
    minutes: 45,
    ingredients: [
      "1 1/2 cups red lentils, rinsed until the water runs clear",
      "3 tbsp extra-virgin olive oil",
      "1 large onion, finely chopped",
      "4 cloves garlic, finely minced",
      "1 tablespoon tomato paste",
      "2 teaspoons ground cumin",
      "1 teaspoon ground coriander",
      "1/2 tsp red pepper flakes, or to taste",
      "1.5 litres vegetable stock",
      "1 large carrot, grated",
      "Juice of 1 lemon, plus wedges for serving",
      "1/4 cup chopped fresh cilantro",
      "Kosher salt and freshly ground black pepper, to taste",
    ],
    instructions: [
      "Cook the onion in the olive oil until golden at the edges, 8 minutes. Stir in the garlic, tomato paste, cumin, coriander and pepper flakes and cook 1 minute.",
      "Add the lentils, carrot and stock. Simmer, partly covered, until the lentils collapse, 25 to 30 minutes.",
      "Blend about half the soup for body, leaving the rest with some texture. Finish with the lemon juice and cilantro, and serve with more lemon at the table.",
    ],
  },
  {
    slug: "black-bean-soup",
    name: "Smoky Black Bean Soup",
    yield: "Serves 6",
    minutes: 50,
    ingredients: [
      "3 (15 oz) cans black beans, drained and rinsed",
      "2 tablespoons olive oil",
      "1 large yellow onion, diced",
      "1 red bell pepper, diced",
      "4 cloves garlic, finely minced",
      "1 tablespoon ground cumin",
      "2 teaspoons smoked paprika",
      "1 chipotle in adobo, minced, plus 1 tsp of the sauce",
      "4 cups low-sodium chicken broth",
      "1 (14.5 oz) can diced tomatoes",
      "Juice of 1 lime",
      "Sour cream, sliced avocado and cilantro, for serving",
      "Kosher salt and freshly ground black pepper, to taste",
    ],
    instructions: [
      "Soften the onion and bell pepper in the oil, 8 minutes. Add the garlic, cumin, paprika and chipotle and cook until fragrant.",
      "Add the beans, tomatoes and broth. Simmer 25 minutes so the flavors settle.",
      "Purée about a third of the soup and stir it back in. Finish with the lime juice and serve with the garnishes.",
    ],
  },

  // ── Salads ────────────────────────────────────────────────────────────────
  {
    slug: "chopped-greek-salad",
    name: "Chopped Greek Salad",
    yield: "4 side servings",
    minutes: 20,
    ingredients: [
      "1 English cucumber, quartered lengthwise and sliced",
      "1 1/2 lbs ripe tomatoes, cut into large chunks",
      "1/2 small red onion, shaved paper-thin",
      "1 green bell pepper, diced",
      "3/4 cup pitted Kalamata olives",
      "6 oz block feta, broken into rough pieces",
      "1/4 cup extra-virgin olive oil",
      "2 tablespoons red wine vinegar",
      "1 teaspoon dried oregano",
      "1 clove garlic, grated",
      "Kosher salt and freshly ground black pepper, to taste",
    ],
    instructions: [
      "Salt the tomatoes and cucumber in a colander for 10 minutes and let the excess water drain away.",
      "Whisk the olive oil, vinegar, oregano and garlic into a dressing.",
      "Toss everything except the feta with the dressing, then lay the feta on top so it stays in recognizable pieces.",
    ],
  },
  {
    slug: "kale-caesar",
    name: "Kale Caesar with Sourdough Croutons",
    yield: "Serves 4",
    minutes: 30,
    ingredients: [
      "2 bunches lacinato kale, stems stripped and leaves sliced into ribbons",
      "4 cups torn day-old sourdough bread",
      "1/4 cup olive oil, divided",
      "2 cloves garlic, grated",
      "4 oil-packed anchovy fillets, mashed to a paste",
      "1 large egg yolk",
      "2 tablespoons fresh lemon juice",
      "1 teaspoon Dijon mustard",
      "1 cup finely grated Parmigiano-Reggiano (about 2 ounces)",
      "Kosher salt and freshly ground black pepper, to taste",
    ],
    instructions: [
      "Toss the bread with half the olive oil and a pinch of salt and bake at 375°F until crisp but still chewy in the middle, 12 minutes.",
      "Whisk the yolk, anchovies, garlic, lemon juice and mustard, then stream in the remaining olive oil to make a loose dressing. Stir in most of the Parmesan.",
      "Massage the dressing into the kale with your hands and let it sit 10 minutes to soften. Add the croutons and the rest of the cheese just before serving.",
    ],
  },
  {
    slug: "farro-squash-salad",
    name: "Warm Farro Salad with Roasted Squash",
    yield: "6 servings",
    minutes: 55,
    ingredients: [
      "1 1/2 cups pearled farro",
      "1 medium butternut squash (about 2 lbs), peeled and cut into 3/4-inch cubes",
      "1/4 cup extra-virgin olive oil, divided",
      "1 tsp ground cinnamon",
      "3 oz baby arugula",
      "1/2 cup dried cranberries",
      "3/4 cup toasted pecans, roughly chopped",
      "4 oz goat cheese, crumbled",
      "3 tablespoons apple cider vinegar",
      "1 tablespoon maple syrup",
      "1 small shallot, minced",
      "Kosher salt and freshly ground black pepper, to taste",
    ],
    instructions: [
      "Roast the squash at 425°F with half the olive oil, the cinnamon, salt and pepper until caramelized at the edges, 30 minutes.",
      "Simmer the farro in well-salted water until tender but chewy, about 25 minutes. Drain and spread on a sheet pan to stop the cooking.",
      "Whisk the vinegar, maple syrup, shallot and remaining olive oil. Toss with the warm farro so it drinks the dressing.",
      "Fold in the squash, arugula, cranberries and pecans. Scatter the goat cheese over the top.",
    ],
  },

  // ── Baking ────────────────────────────────────────────────────────────────
  {
    slug: "buttermilk-banana-bread",
    name: "Buttermilk Banana Bread",
    yield: "1 loaf",
    minutes: 75,
    ingredients: [
      "3 very ripe bananas, mashed (about 1 1/4 cups)",
      "1½ cups all-purpose flour",
      "115 g unsalted butter, melted and cooled",
      "3/4 cup packed light brown sugar",
      "2 large eggs, at room temperature",
      "1/3 cup buttermilk",
      "1 teaspoon baking soda",
      "1/2 tsp fine sea salt",
      "1 1/2 teaspoons vanilla extract",
      "1 teaspoon ground cinnamon",
      "3/4 cup toasted walnuts, chopped (optional)",
    ],
    instructions: [
      "Heat the oven to 350°F and line a 9x5-inch loaf pan with parchment.",
      "Whisk the melted butter and brown sugar, then the eggs one at a time, then the bananas, buttermilk and vanilla.",
      "Fold in the flour, baking soda, salt and cinnamon until barely combined — a few streaks of flour are fine. Fold in the walnuts.",
      "Bake 55 to 65 minutes, until a skewer comes out with a couple of moist crumbs. Cool in the pan 15 minutes before turning out.",
    ],
  },
  {
    slug: "brown-butter-chocolate-chip-cookies",
    name: "Brown Butter Chocolate Chip Cookies",
    yield: "About 24 cookies",
    minutes: 60,
    ingredients: [
      "250 g all-purpose flour",
      "2 sticks unsalted butter (226 grams)",
      "1 cup packed dark brown sugar",
      "1/2 cup granulated sugar",
      "2 large eggs, at room temperature",
      "1 tablespoon vanilla extract",
      "1 tsp baking soda",
      "1 1/4 teaspoons kosher salt",
      "300 g bittersweet chocolate, chopped into shards",
      "Flaky sea salt, for finishing",
    ],
    instructions: [
      "Brown the butter over medium heat until the milk solids are toasted and it smells nutty, then cool it until it is no longer hot to the touch.",
      "Beat the butter with both sugars, then the eggs and vanilla, until the mixture is glossy and thick.",
      "Stir in the flour, baking soda and salt, then the chocolate. Chill the dough at least 30 minutes — overnight is better.",
      "Bake scoops at 375°F for 10 to 12 minutes, until the edges are set and the centers still look underdone. Finish with flaky salt.",
    ],
  },
  {
    slug: "overnight-focaccia",
    name: "No-Knead Overnight Focaccia",
    yield: "One 9x13-inch pan",
    minutes: 90,
    ingredients: [
      "500 g bread flour",
      "400 g lukewarm water",
      "10 g fine sea salt",
      "4 g instant yeast",
      "1/4 cup extra-virgin olive oil, plus more for the pan",
      "2 sprigs fresh rosemary, leaves picked",
      "Flaky sea salt, for the top",
    ],
    instructions: [
      "Mix the flour, water, salt and yeast with a spatula until no dry flour remains. Cover and refrigerate 12 to 18 hours.",
      "Oil a 9x13-inch pan generously. Fold the dough over on itself four times, transfer it to the pan, and let it come to room temperature and relax, 2 to 3 hours.",
      "Dimple the dough all over with oiled fingertips, scatter the rosemary and flaky salt, and drizzle with more olive oil.",
      "Bake at 450°F for 25 to 30 minutes, until the top is deep golden and the bottom is crisp.",
    ],
  },

  // ── Pasta ─────────────────────────────────────────────────────────────────
  {
    slug: "bucatini-amatriciana",
    name: "Bucatini all'Amatriciana",
    yield: "Serves 4",
    minutes: 35,
    ingredients: [
      "1 lb bucatini",
      "6 oz guanciale, cut into thick matchsticks",
      "1 (28 ounce) can whole peeled tomatoes, crushed by hand",
      "1/2 tsp red pepper flakes",
      "1 cup finely grated Pecorino Romano",
      "1 tablespoon olive oil",
      "1/2 cup dry white wine",
      "Kosher salt and freshly ground black pepper, to taste",
    ],
    instructions: [
      "Render the guanciale in the olive oil over medium-low heat until the fat is clear and the meat is crisp, 10 minutes. Lift it out and reserve.",
      "Add the pepper flakes and the wine, reduce by half, then the tomatoes. Simmer 15 minutes.",
      "Boil the bucatini in well-salted water until 2 minutes short of al dente and transfer it to the sauce with a mug of pasta water.",
      "Toss hard over the heat until the sauce clings, then kill the heat and beat in the Pecorino and the guanciale.",
    ],
  },
  {
    slug: "baked-ziti",
    name: "Baked Ziti with Italian Sausage",
    yield: "8 servings",
    minutes: 75,
    ingredients: [
      "1 lb ziti",
      "1 lb sweet Italian sausage, casings removed",
      "1 (24 oz) jar marinara sauce",
      "1 (14.5 oz) can diced tomatoes",
      "15 oz whole-milk ricotta",
      "1 large egg",
      "12 ounces low-moisture mozzarella, shredded (about 3 cups)",
      "3/4 cup grated Parmesan",
      "3 cloves garlic, finely minced",
      "1/4 cup chopped fresh basil",
      "2 tablespoons olive oil",
      "Kosher salt and freshly ground black pepper, to taste",
    ],
    instructions: [
      "Brown the sausage in the olive oil, breaking it into small pieces. Add the garlic, then the marinara and the diced tomatoes, and simmer 15 minutes.",
      "Boil the ziti 3 minutes short of the box time; it finishes in the oven. Stir the ricotta with the egg, the Parmesan and the basil.",
      "Layer half the pasta and sauce in a 9x13-inch dish, dollop over the ricotta mixture, then the rest of the pasta and sauce. Top with the mozzarella.",
      "Bake covered at 375°F for 25 minutes, then uncovered for 15 more, until browned and bubbling. Rest 10 minutes before serving.",
    ],
  },
  {
    slug: "shrimp-scampi",
    name: "Lemon Garlic Shrimp Scampi",
    yield: "4 servings",
    minutes: 25,
    ingredients: [
      "1 lb large shrimp, peeled and deveined",
      "12 oz linguine",
      "6 tablespoons unsalted butter",
      "3 tbsp extra-virgin olive oil",
      "8 cloves garlic, thinly sliced",
      "1/2 teaspoon red pepper flakes",
      "3/4 cup dry white wine",
      "1 lemon, zested and juiced",
      "1/3 cup chopped fresh flat-leaf parsley",
      "Kosher salt and freshly ground black pepper, to taste",
    ],
    instructions: [
      "Start the linguine in heavily salted water.",
      "Warm the garlic and pepper flakes in the olive oil and 2 tablespoons of the butter until the garlic is barely blond — browned garlic will turn the whole dish bitter.",
      "Add the wine and reduce by half, then the shrimp. Cook just until they curl and turn opaque, 2 to 3 minutes.",
      "Off the heat, swirl in the remaining butter, the lemon zest and juice and the parsley. Toss with the drained pasta and a splash of its water.",
    ],
  },

  // ── Curries ───────────────────────────────────────────────────────────────
  {
    slug: "chicken-tikka-masala",
    name: "Chicken Tikka Masala",
    yield: "Serves 6",
    minutes: 70,
    ingredients: [
      "2 lbs boneless, skinless chicken thighs, cut into large chunks",
      "1 cup whole-milk yogurt",
      "2 tablespoons garam masala, divided",
      "1 (2-inch) piece fresh ginger, peeled and grated",
      "6 cloves garlic, finely minced",
      "3 tablespoons ghee or unsalted butter",
      "1 large onion, finely chopped",
      "1 (14.5 oz) can crushed tomatoes",
      "1 cup heavy cream",
      "2 teaspoons ground turmeric",
      "1 tablespoon ground cumin",
      "1 tsp cayenne pepper, or to taste",
      "1/2 cup chopped fresh cilantro",
      "Basmati rice and naan, for serving",
      "Kosher salt and freshly ground black pepper, to taste",
    ],
    instructions: [
      "Marinate the chicken in the yogurt, half the garam masala, half the ginger and half the garlic for at least 2 hours, ideally overnight.",
      "Broil or grill the chicken on a rack until charred in spots — it does not need to be cooked through yet.",
      "Cook the onion in the ghee until deeply golden, then add the remaining garlic and ginger, the rest of the garam masala, the turmeric, cumin and cayenne. Fry the spices 1 minute.",
      "Add the tomatoes and simmer 15 minutes, then the cream and the chicken with any resting juices. Simmer 15 minutes more and finish with cilantro.",
    ],
  },
  {
    slug: "thai-green-curry",
    name: "Thai Green Curry with Chicken",
    yield: "4 servings",
    minutes: 40,
    ingredients: [
      "500 g chicken breast, sliced thin",
      "3 tablespoons green curry paste",
      "2 (13.5 oz) cans full-fat coconut milk",
      "1 tablespoon fish sauce, plus more to taste",
      "2 teaspoons palm sugar or light brown sugar",
      "1 Japanese eggplant, cut into half-moons",
      "1 cup green beans, trimmed and halved",
      "1 red chili, thinly sliced",
      "1 cup Thai basil leaves",
      "4 kaffir lime leaves, torn",
      "Juice of 1/2 lime",
      "Jasmine rice, for serving",
    ],
    instructions: [
      "Spoon the thick cream from the top of one can of coconut milk into a hot pan and fry it with the curry paste until the oil splits out and the paste smells toasted, 4 minutes.",
      "Add the chicken and turn it in the paste, then pour in the rest of the coconut milk and the lime leaves.",
      "Simmer with the eggplant and green beans until tender, 12 minutes.",
      "Season with fish sauce, sugar and lime juice until it tastes salty, sweet and sour in that order. Fold in the basil and chili off the heat.",
    ],
  },
  {
    slug: "chana-masala",
    name: "Chana Masala",
    yield: "4 to 6 servings",
    minutes: 45,
    ingredients: [
      "2 (15.5 ounce) cans chickpeas, drained and rinsed",
      "3 tablespoons neutral oil",
      "1 large onion, finely chopped",
      "1 tbsp garlic, minced (about 3 cloves)",
      "1 tablespoon grated fresh ginger",
      "400 g tin chopped tomatoes",
      "2 teaspoons ground coriander",
      "1 1/2 teaspoons ground cumin",
      "1 teaspoon amchur (dried mango powder)",
      "1/2 teaspoon ground turmeric",
      "1 teaspoon garam masala",
      "1/2 cup water",
      "1/2 cup chopped fresh cilantro",
      "Kosher salt and freshly ground black pepper, to taste",
    ],
    instructions: [
      "Fry the onion in the oil over medium-high heat until browned at the edges, 10 minutes — this is where the color of the finished dish comes from.",
      "Add the garlic and ginger, then the coriander, cumin, turmeric and amchur. Fry 1 minute.",
      "Add the tomatoes and cook until the oil separates, 8 minutes. Add the chickpeas and the water and simmer 15 minutes, mashing a few chickpeas to thicken.",
      "Finish with the garam masala and cilantro.",
    ],
  },

  // ── Breakfasts ────────────────────────────────────────────────────────────
  {
    slug: "sheet-pan-breakfast-hash",
    name: "Sheet Pan Breakfast Hash",
    yield: "Serves 4",
    minutes: 45,
    ingredients: [
      "2 lbs Yukon Gold potatoes, cut into 1/2-inch dice",
      "1 lb breakfast sausage, crumbled",
      "1 red bell pepper, diced",
      "1 medium yellow onion, diced",
      "3 tablespoons olive oil",
      "2 teaspoons smoked paprika",
      "6 large eggs",
      "4 oz sharp cheddar, shredded",
      "2 scallions, thinly sliced",
      "Kosher salt and freshly ground black pepper, to taste",
      "Hot sauce, for serving",
    ],
    instructions: [
      "Toss the potatoes with the oil, paprika, salt and pepper and roast at 425°F for 20 minutes on a sheet pan.",
      "Stir in the sausage, pepper and onion and roast 15 minutes more, until the sausage is cooked and the potatoes are crisp.",
      "Make six wells, crack an egg into each, scatter over the cheddar, and return to the oven for 6 to 8 minutes, until the whites set.",
      "Top with scallions and serve straight from the pan.",
    ],
  },
  {
    slug: "buttermilk-pancakes",
    name: "Tall Buttermilk Pancakes",
    yield: "About 12 pancakes",
    minutes: 30,
    ingredients: [
      "2 cups all-purpose flour",
      "2 tablespoons granulated sugar",
      "2 teaspoons baking powder",
      "1/2 teaspoon baking soda",
      "1 tsp fine sea salt",
      "2 cups buttermilk",
      "2 large eggs",
      "4 tablespoons unsalted butter, melted, plus more for the pan",
      "1 teaspoon vanilla extract",
      "Maple syrup and berries, for serving",
    ],
    instructions: [
      "Whisk the dry ingredients in one bowl and the buttermilk, eggs, melted butter and vanilla in another.",
      "Combine with a few strokes only. Lumps are correct; a smooth batter makes tough pancakes. Rest the batter 10 minutes.",
      "Cook in butter over medium-low heat until bubbles break the surface and the edges look dry, then flip once.",
    ],
  },
  {
    slug: "spinach-feta-baked-eggs",
    name: "Spinach and Feta Baked Eggs",
    yield: "2 to 3 servings",
    minutes: 30,
    ingredients: [
      "10 oz baby spinach",
      "6 large eggs",
      "4 oz feta, crumbled",
      "2 tbsp unsalted butter",
      "2 cloves garlic, finely minced",
      "1/2 cup heavy cream",
      "1/4 teaspoon freshly grated nutmeg",
      "1/2 tsp red pepper flakes",
      "Crusty bread, for serving",
      "Kosher salt and freshly ground black pepper, to taste",
    ],
    instructions: [
      "Wilt the spinach in the butter with the garlic, then squeeze out as much liquid as you can and chop it roughly.",
      "Spread the spinach in a buttered baking dish, pour over the cream, and season with the nutmeg, salt and pepper.",
      "Make wells for the eggs, crack them in, scatter over the feta and pepper flakes, and bake at 400°F for 12 to 15 minutes, until the whites are just set.",
    ],
  },

  // ── Tacos ─────────────────────────────────────────────────────────────────
  {
    slug: "carnitas-tacos",
    name: "Slow Cooker Carnitas Tacos",
    yield: "Makes about 12 tacos",
    minutes: 300,
    ingredients: [
      "4 lbs boneless pork shoulder, cut into 3-inch chunks",
      "1 tablespoon kosher salt",
      "2 teaspoons ground cumin",
      "1 tablespoon dried oregano",
      "1 large white onion, quartered",
      "6 cloves garlic, smashed",
      "2 oranges, juiced (peels reserved)",
      "1 cinnamon stick",
      "2 bay leaves",
      "12 corn tortillas, warmed",
      "1/2 cup finely diced white onion",
      "1/2 cup chopped fresh cilantro",
      "Lime wedges, for serving",
    ],
    instructions: [
      "Rub the pork with the salt, cumin and oregano. Put it in a slow cooker with the quartered onion, garlic, orange juice and peels, cinnamon stick and bay leaves.",
      "Cook on low for 8 hours, or high for 5, until the meat gives up completely.",
      "Shred the pork, discard the aromatics, and spread it on a sheet pan with a few spoonfuls of the cooking liquid. Broil until the edges are crisp and lacquered.",
      "Serve on warm tortillas with the diced onion, cilantro and lime.",
    ],
  },
  {
    slug: "fish-tacos",
    name: "Fish Tacos with Cabbage Slaw",
    yield: "Serves 4",
    minutes: 35,
    ingredients: [
      "1 1/2 lbs firm white fish such as cod or mahi-mahi",
      "1 tablespoon chili powder",
      "1 teaspoon ground cumin",
      "2 tablespoons olive oil",
      "1/2 small head green cabbage, shredded (about 4 cups)",
      "1/2 cup sour cream",
      "1/4 cup mayonnaise",
      "Juice of 2 limes",
      "1 jalapeño, seeded and minced",
      "1/3 cup chopped fresh cilantro",
      "8 (6-inch) corn tortillas",
      "1 avocado, sliced",
      "Kosher salt and freshly ground black pepper, to taste",
    ],
    instructions: [
      "Whisk the sour cream, mayonnaise, half the lime juice and the jalapeño, then toss with the cabbage and cilantro. Let the slaw sit while you cook the fish.",
      "Rub the fish with the oil, chili powder, cumin, salt and pepper. Sear in a very hot pan 3 to 4 minutes per side, until it flakes.",
      "Break the fish into large pieces, pile onto charred tortillas with the slaw and avocado, and finish with the remaining lime.",
    ],
  },
  {
    slug: "sweet-potato-black-bean-tacos",
    name: "Roasted Sweet Potato and Black Bean Tacos",
    yield: "Makes 8 tacos",
    minutes: 40,
    ingredients: [
      "2 lbs sweet potatoes, cut into 3/4-inch cubes",
      "1 (15 oz) can black beans, drained and rinsed",
      "3 tablespoons olive oil",
      "2 teaspoons ground cumin",
      "1 teaspoon smoked paprika",
      "1/2 tsp chipotle powder",
      "8 flour tortillas",
      "4 oz cotija cheese, crumbled",
      "1/2 red onion, thinly sliced and rinsed",
      "1/3 cup chopped fresh cilantro",
      "Juice of 1 lime",
      "Kosher salt and freshly ground black pepper, to taste",
    ],
    instructions: [
      "Toss the sweet potatoes with the oil, cumin, paprika, chipotle powder, salt and pepper. Roast at 425°F for 25 minutes, turning once, until browned.",
      "Add the black beans to the pan for the last 5 minutes so they warm and dry slightly.",
      "Pile into warm tortillas with the cotija, red onion, cilantro and a squeeze of lime.",
    ],
  },
];

// ---------------------------------------------------------------------------
// The Paprika fixtures
// ---------------------------------------------------------------------------

/**
 * Read every committed Paprika fixture into the same `SeedRecipe` shape.
 *
 * See the header for why this is not one `parsePaprikaRecipe` call. The two
 * behaviours reproduced here are the ones the fixtures exist to pin down:
 * ingredients come from the shared schema.org crosswalk, and instructions are
 * read one step per `<p>` — Paprika writes ONE `recipeInstructions` container
 * holding N paragraphs, and the generic reader would return a single run-on
 * blob, which is the most damaging thing an importer can do to a recipe.
 */
async function fixtureRecipes(): Promise<SeedRecipe[]> {
  const { parse } = (await import("../packages/recipe-extract/node_modules/node-html-parser/dist/index.mjs")) as typeof NodeHtmlParser;

  const out: SeedRecipe[] = [];
  for (const file of readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".html"))
    .sort()) {
    const root = parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
    // Same scoping rule the importer uses: prefer the Recipe itemscope, fall
    // back to the whole document so a stripped-down export still reads.
    const scope = root.querySelector('[itemtype*="Recipe" i]') ?? root;
    const recipe = schemaOrgToLexicon(readItem(scope), "");
    const instructions = scope
      .querySelectorAll('[itemprop="recipeInstructions"] p')
      .map((p) => p.text.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    const ingredients = recipe.ingredients ?? [];
    if (!recipe.name || ingredients.length === 0) throw new Error(`fixture ${file} produced no usable recipe — the crosswalk or the fixture changed`);

    out.push({
      id: `${ID_PREFIX}paprika-${file.replace(/\.html$/, "")}`,
      name: recipe.name,
      recipeYield: recipe.recipeYield ?? null,
      totalTime: recipe.totalTime ?? recipe.cookTime ?? null,
      ingredients: [...ingredients],
      instructions,
    });
  }
  return out;
}

/** `PT1H30M` → 5400. Deliberately narrow: the only durations reaching it are the
 *  ones this script writes plus whatever the fixtures carry, and a wrong number
 *  here would show a lie on the recipe card. Anything it does not recognize
 *  becomes null, which the schema already allows. */
function durationSeconds(iso: string | null): number | null {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? "");
  if (!m) return null;
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return seconds > 0 ? seconds : null;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/**
 * `services/web/.env` is the one place the dev connection string lives (see
 * AGENTS.md); the app loads it through Vite and the migrations through
 * `kysely.config.ts`, neither of which is available here. Absent file is not
 * fatal on its own — an exported `DATABASE_URL` is just as good — so the check
 * that matters is the one on the variable itself.
 */
function loadDatabaseUrl(): string {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // Fall through to whatever the environment already carries.
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(`No DATABASE_URL. Expected it in ${ENV_FILE} — run \`pnpm dev\` once to bootstrap the local stack.`);
  return url;
}

async function connect(): Promise<Kysely<DB>> {
  const { Pool } = ((await import("../services/web/node_modules/pg/lib/index.js")) as { default: typeof Pg }).default;
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: loadDatabaseUrl() }) }) });
}

async function main(): Promise<void> {
  const recipes: SeedRecipe[] = [
    ...(await fixtureRecipes()),
    ...SEED_RECIPES.map((r) => ({
      id: `${ID_PREFIX}${r.slug}`,
      name: r.name,
      recipeYield: r.yield,
      totalTime: `PT${r.minutes}M`,
      ingredients: [...r.ingredients],
      instructions: [...r.instructions],
    })),
  ];

  const db = await connect();
  try {
    // Every household, not just the active one: a dev database usually has one,
    // but anyone testing the household-switching paths has several and wants the
    // corpus visible from all of them.
    const households = await db.selectFrom("household").select(["id", "name", "created_by_did"]).where("deleted_at", "is", null).orderBy("created_at").execute();

    if (households.length === 0) {
      // Not an error. A fresh dev database legitimately has no households — the
      // first one is created by signing in — and failing here would look like a
      // broken script rather than a missing step.
      process.stdout.write(
        "\nNo households found, so there is nowhere to put these recipes.\n\n" +
          "  Sign in at http://127.0.0.1:3000/login as chef.test first (127.0.0.1, never\n" +
          "  localhost — atproto forbids `.localhost` in web client_ids), then run this\n" +
          "  script again.\n\n",
      );
      return;
    }

    await pruneStaleSeedRecipes(db, new Set(recipes.map((r) => r.id)));

    let ingredientCount = 0;
    let instructionCount = 0;
    let attachments = 0;

    // One transaction for the whole corpus: a half-seeded database is harder to
    // reason about than an unseeded one, and this is small enough that holding
    // the transaction costs nothing.
    await db.transaction().execute(async (trx) => {
      for (const recipe of recipes) {
        await trx
          .insertInto("recipe")
          .values({
            id: recipe.id,
            // 'local' and never 'sync': the cron reconciler owns 'sync' rows and
            // would eventually notice these have no record behind them. 'local'
            // rows it never touches. `private` + null `uri` is exactly how an
            // unpublished, household-only recipe looks to the read path.
            origin: "local",
            visibility: "private",
            name: recipe.name,
            recipe_yield: recipe.recipeYield,
            total_time: recipe.totalTime,
            total_time_seconds: durationSeconds(recipe.totalTime),
          })
          .onConflict((oc) =>
            oc.column("id").doUpdateSet({
              name: recipe.name,
              recipe_yield: recipe.recipeYield,
              total_time: recipe.totalTime,
              total_time_seconds: durationSeconds(recipe.totalTime),
            }),
          )
          .execute();

        // Replace rather than upsert, so shortening a recipe cannot leave
        // orphaned high ordinals behind. Neither table has an inbound FK, so
        // this is safe in a way deleting the `recipe` row is not.
        await trx.deleteFrom("recipe_ingredient").where("recipe_id", "=", recipe.id).execute();
        await trx.deleteFrom("recipe_instruction").where("recipe_id", "=", recipe.id).execute();

        await trx
          .insertInto("recipe_ingredient")
          .values(recipe.ingredients.map((text, ordinal) => ({ recipe_id: recipe.id, ordinal, text })))
          .execute();
        ingredientCount += recipe.ingredients.length;

        if (recipe.instructions.length > 0) {
          await trx
            .insertInto("recipe_instruction")
            .values(recipe.instructions.map((text, ordinal) => ({ recipe_id: recipe.id, ordinal, text })))
            .execute();
          instructionCount += recipe.instructions.length;
        }

        for (const household of households) {
          // `added_by_did` is provenance and NOT NULL; the household's creator is
          // the only did this script can honestly claim.
          const res = await trx
            .insertInto("household_recipe")
            .values({ household_id: household.id, recipe_id: recipe.id, added_by_did: household.created_by_did })
            .onConflict((oc) => oc.columns(["household_id", "recipe_id"]).doNothing())
            .execute();
          attachments += Number(res[0]?.numInsertedOrUpdatedRows ?? 0n);
        }
      }
    });

    process.stdout.write(
      `\nSeeded ${recipes.length} recipes (${recipes.length - SEED_RECIPES.length} from Paprika fixtures, ${SEED_RECIPES.length} authored inline)\n` +
        `  ${ingredientCount} ingredient lines\n` +
        `  ${instructionCount} instruction steps\n` +
        `  ${households.length} household(s): ${households.map((h) => h.name).join(", ")}\n` +
        `  ${attachments} new household attachment(s) this run (the rest were already boxed)\n\n`,
    );
  } finally {
    await db.destroy();
  }
}

/**
 * Drop `seed-` recipes left over from an earlier version of this corpus.
 *
 * Best-effort by design: `meal_plan_entry.recipe_id` is ON DELETE RESTRICT, so a
 * retired recipe that somebody has put on a meal plan cannot be deleted, and
 * that must not stop the rest of the seed from running. Warn and move on.
 */
async function pruneStaleSeedRecipes(db: Kysely<DB>, keep: Set<string>): Promise<void> {
  const existing = await db.selectFrom("recipe").select("id").where("id", "like", `${ID_PREFIX}%`).execute();
  const stale = existing.map((r) => r.id).filter((id) => !keep.has(id));
  if (stale.length === 0) return;

  try {
    await db.transaction().execute(async (trx) => {
      // household_recipe → recipe is ON DELETE RESTRICT, so the box rows go first.
      await trx.deleteFrom("household_recipe").where("recipe_id", "in", stale).execute();
      await trx.deleteFrom("recipe").where("id", "in", stale).execute();
    });
    process.stdout.write(`Removed ${stale.length} stale seed recipe(s) no longer in the corpus.\n`);
  } catch (err) {
    process.stdout.write(`Could not remove ${stale.length} stale seed recipe(s) (${err instanceof Error ? err.message : String(err)}); leaving them in place.\n`);
  }
}

await main();
