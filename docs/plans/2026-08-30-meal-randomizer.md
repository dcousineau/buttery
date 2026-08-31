# 2026-08-30 — Meal randomizer ("What should I make?")

Status: **spec / pre-development**
Supersedes the 2026-08-03 draft of this file (same feature; rewritten after the
planner, grocery list, collections and enrichment work landed).

Depends on:

- `01-atproto-cron-sync-service.md` — the rendered `recipe` layer (`recipe`,
  `recipe_ingredient`, `recipe_cuisine`/`recipe_category` vocab columns,
  `*_time_seconds`).
- `02-households-and-private-foundation.md` — household spine, `assertMember`,
  `householdScopedQuery`, `session.active_household_id`.
- `03-household-recipe-collection.md` — the recipe box (`household_recipe`),
  `listHouseholdRecipes`, `searchGlobalRecipes`, `deriveSource`, the
  `/household/recipes` layout route and `DetailPane`.
- `2026-08-06-meal-planner.md` — `meal_plan_entry`, `getPlanToday`,
  `addMealPlanRecipes`, `AddToPlanDialog`, `lib/plan/week.ts`.
- `2026-08-11-grocery-list.md` — `previewGroceryAdd` / `commitGroceryAdd` and
  `AddPreviewDialog`.
- `2026-08-20-collections.md` — `recipe_collection*`, the `?c=` scope on the
  recipes layout.
- `2026-08-20-recipe-enrichment.md` + `2026-08-26-llm-recipe-enrichment.md` —
  `recipe_enrichment`, `recipe_enrichment_label`, and the `diet` / `allergen` /
  `cuisine` / `meal_type` / `spice_level` vocabulary this feature filters on.
- `2026-08-28-recipe-enrichment-tags-ui.md` — `lib/recipe-tags.ts`,
  `RecipeTagStrip`, and the verdict policy the filters must not contradict.

Adapted from an external, stack-agnostic **Meal Randomizer PRD**
(`RANDOMIZER_PRD.md`, working file — not committed). That PRD was written for a
different app: it assumes a flat recipe library, no meal plan, no shopping list,
and hand-rolled attributes. This spec maps its _behaviour_ onto what Buttery
actually has now, and records every place the mapping changed the shape (§2).

---

## 1. Overview

A **"what should I make?"** randomizer over the **active household's recipe
box**. The user sets a few lightweight filters, hits one button, and gets one
random recipe — solving decision fatigue without browsing the whole shelf.

Plan `03` §1.2 parked "Collections / Randomizer" as `soon` in the nav
(`AppSidebar.tsx:32` still has `soon: true`). This is that project. It adds
**no tables** and **one** new read-only server function.

The thing that changed most since the first draft: **the randomizer no longer
owns its own result screen.** The PRD's §4 (a shopping-list rendering) and §5
(copy & share to a partner) existed because the host app had neither a grocery
list nor a meal plan. Buttery has both, plus cook mode. So the draw's result is
the **real recipe view** — the same `DetailPane` the box renders — parked
directly below the randomizer controls, with its real actions live (§7).

### 1.1 In scope

- A randomizer surface under the recipes route (§6.1): filter controls, a
  "What should I make?" trigger, "Roll again", and the drawn recipe rendered as
  the full recipe detail below the controls.
- One new server function, `getRandomizerPool`, applying every filter
  server-side over the household box and returning the eligible lightweight pool
  (§4).
- Filters over the **enrichment** dimensions that now exist — diet, allergen
  (exclusion), cuisine, meal type, spice level — plus time, ingredient text,
  collection, favourites, and a "skip what we've had recently" filter that reads
  the meal plan (§4.1).
- Client-side draw / re-roll / no-repeat over the returned pool (§5).
- The result pane's actions, all pre-existing: add to grocery list, add to meal
  plan (with a one-click "add to today's <current slot>", §8), start cook mode,
  favourite, scale, open full recipe (§7).
- Optional **corpus widening**: when the box pool is empty, offer to fold in
  matching public recipes (§4.5).
- **Randomizer** becomes an active nav item (was `soon`).

### 1.2 Out of scope

- **PRD §4 (shopping list view) and §5 (copy & share) as specified.** Both are
  dropped, not deferred — see §2.5. The grocery list replaces §4; nothing
  replaces §5.
- Any new table or migration. One new pure helper module is the whole non-route
  code footprint beyond the server function.
- Multi-recipe or whole-week randomizing ("fill my week"). Tempting, and the
  planner would take it — but it is a different feature with a different UI, and
  the PRD's whole framing is _one_ suggestion. Note it in results if it keeps
  coming up.
- Cross-session persistence of the "last suggested" recipe (in-session only; PRD
  §3.3 marks persistence a nice-to-have).
- Offline. The pool comes from a server function, so the surface needs the
  network. It must **fail like the other online-only surfaces**
  (`OfflineRouteError` / the `OFFLINE_WRITE_HINT` idiom), not throw.

---

## 2. PRD → Buttery fit (the mapping, and the five calls)

The PRD is stack-agnostic and its field list is illustrative. Buttery's recipe
model is far richer than it assumed, and three of the four gaps the 2026-08-03
draft recorded have since closed.

| PRD field / behaviour             | Buttery reality (2026-08-30)                                                                                                                                                                     | Decision                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Name                              | `recipe.name`                                                                                                                                                                                    | direct                                                                                     |
| Cuisine                           | author `recipe.recipe_cuisine` **and** `recipe_enrichment_label` dimension `cuisine` — same `recipe_vocab` dimension, so the slugs are comparable                                                | **§2.1** one filter, matching either source                                                |
| Meal type (soup/salad/bowl/plate) | `recipe_enrichment_label` dimension `meal_type`: `breakfast lunch dinner dessert snack side drink`. Author `recipe_category` is a separate, sparser free-ish vocab                               | **§2.2** filter on the enrichment dimension only                                           |
| Cook time (min)                   | `recipe.cook_time_seconds` **and** `recipe.total_time_seconds`                                                                                                                                   | **§2.3** filter `total_time_seconds`; nulls excluded when the filter is on, with an opt-in |
| Ingredients list                  | `recipe_ingredient(recipe_id, ordinal, text)`                                                                                                                                                    | direct — substring `ILIKE` (§4.4)                                                          |
| **Protein-forward flag**          | Still no such column, and `recipe_enrichment`'s nutrition columns **all land null** (enrichment results §1.2 — no nutrition estimation shipped). But the LLM emits `low_carb` / `keto` / `paleo` | **§2.4** ship it as an honestly-labelled low-carb proxy, default **OFF**                   |
| Shopping list view (PRD §4)       | The grocery list exists, with aisle grouping, quantity merging and a confirm preview                                                                                                             | **§2.5** dropped; the result pane's "Add to shopping list" replaces it                     |
| Copy & share (PRD §5)             | Nothing equivalent, and the use case (tell your partner) is now served by a shared household list and a shared plan                                                                              | **§2.5** dropped outright                                                                  |
| Draw from "full recipe library"   | Two surfaces: household box (small, curated) vs global public corpus (huge)                                                                                                                      | **§2.6** box, with an opt-in widen-to-corpus when the box pool is empty                    |

### 2.1 Cuisine — author value OR derived label

One select. A recipe matches slug `s` if `r.recipe_cuisine = s` **or** it has a
`recipe_enrichment_label` row `(dimension='cuisine', slug=s)`. This is safe
because `cuisine` is a single `recipe_vocab` dimension: migration
`1785300000000` seeded 33 upstream-aliased slugs and `1787783591746` added the 6
the LLM needed that were missing — the LLM is not writing into a parallel
vocabulary (llm-enrichment results, "cuisine is not a new dimension").

The select's options are the distinct slugs **present in the current pool
source**, labelled via `recipe_vocab.label` / `recipe-provenance.prettify` —
never the full 39-slug vocabulary, most of which no household owns.

### 2.2 Meal type — the enrichment dimension, not `recipe_category`

The meal-type filter is a single-select over the enrichment `meal_type`
dimension. `recipe_category` is **not** offered as a second filter.

Two reasons, in order. The enrichment dimension is a closed 7-slug set applied
uniformly by one classifier, so "dinner" means the same thing for a synced
recipe and a hand-typed one; `recipe_category` is whatever the source site's
JSON-LD said, so it holds "Entree", "Dinner", "Main Course" and "Soup" as four
unrelated tokens. And the PRD's own examples (soup / salad / bowl / plate) were
illustrations, not requirements — what the question "what should I make?"
actually needs to narrow is _which meal_, which is exactly this dimension.

Cost, stated plainly: a recipe with no `meal_type` label is invisible while this
filter is active. That is a coverage problem, not a correctness one, and §4.3
says how the UI must surface it.

### 2.3 Cook time — `total_time_seconds`, nulls excluded by default

"Max cook time" filters on `total_time_seconds` (the value the `03` box UI
already displays via `minutesDisplay`), so the number the filter uses is the
number the card shows. When the filter is active, recipes with
`total_time_seconds IS NULL` are **excluded**, with an **"include untimed
recipes"** checkbox that keeps them eligible.

### 2.4 Protein-forward — shipped as a low-carb proxy, default OFF

The PRD wants a boolean, defaulted **ON**, meaning "protein is the centrepiece,
vegetables are prominent, not primarily a pasta or rice dish."

Buttery still cannot compute that literally. `recipe_enrichment.protein_g` and
`carbohydrate_g` exist as columns but **every row is null** — the enrichment
plan explicitly shipped no nutrition estimation. What _is_ derivable is the
LLM's `low_carb` / `keto` / `paleo` diet judgments, which are ingredient-shape
guesses (llm schema.ts, `LLM_ONLY_DIET_SLUGS`) — and "not primarily pasta or
rice" is very nearly the definition of the low-carb guess.

**Decision:** ship a toggle implemented as

```
EXISTS (label WHERE dimension='diet' AND verdict='likely'
        AND slug IN ('low_carb','keto','paleo'))
```

labelled for what it actually is — **"Protein-forward (low-carb)"** with helper
text "Uses our low-carb / keto / paleo read of the ingredients" — and defaulted
**OFF**, not ON as the PRD asks.

Two divergences, both deliberate. The label is honest because a toggle that
claims to know "vegetables are prominent" would be lying about a signal nobody
computed. The default is OFF because it is a proxy layered on enrichment
coverage that is not yet measured in production; defaulting ON would silently
empty most pools on day one, which is precisely the failure the 2026-08-03 draft
dropped the flag to avoid. **Revisit the default once coverage is measured** —
record the number in the results doc (§11).

### 2.5 Shopping list and copy & share — replaced and dropped

PRD §4 asks for a plain per-recipe ingredient rendering with no dedupe, no aisle
grouping and no cross-recipe merge, _"unless the host app already has
multi-recipe list-merging elsewhere, in which case this feature can optionally
feed into it."_ Buttery does: `previewGroceryAdd` / `commitGroceryAdd`, aisle
grouping via `@buttery/food/aisles`, quantity merging, and a confirm dialog. So
the randomizer builds **no list view of its own** — the result pane's existing
"Add to shopping list" button is the whole of PRD §4, and it is strictly better
than what the PRD asked for.

PRD §5 (copy a plain-text summary to the clipboard so a partner can confirm the
meal or shop on the way home) is **dropped, not deferred.** Its use case is
household coordination, and in Buttery the household already shares one grocery
list and one meal plan — the partner does not need a pasted message, they need
the item on the list they are already holding. Building a clipboard path beside
that adds a second, unsynced way to say the same thing. If someone still wants
to text a recipe, the recipe has a public URL and the OS share sheet.

### 2.6 Draw pool — household box, widen to corpus on demand

The randomizer draws from the **active household's box** — the curated shelf,
which matches the PRD's "instead of browsing the full library" framing and is
small enough to draw over client-side. When the filtered box pool is **empty**,
the UI offers to widen to matching public recipes (§4.5). Widening is explicit
and opt-in, never automatic.

---

## 3. No new data model

This feature is **read-only over existing tables** — `03`'s box, the enrichment
tables, and `meal_plan_entry` for the recency filter. Nothing is migrated.
Nothing is written except through server functions that already exist (grocery,
plan, cook, favourite).

Authorization is the same chokepoint every box query uses:
`householdScopedQuery(db, did, householdId)` joined to `household_recipe`, with
the active household resolved from `session.active_household_id` (never a client
argument) via `activeContext()` in `services/web/src/server/household-recipes.ts`.

---

## 4. Server function — `getRandomizerPool`

One new `createServerFn({ method: "GET" })`. Put it in a new
`services/web/src/server/randomizer.ts` rather than growing `household-recipes.ts`,
and follow the now-standard shape (planner deviation 11): a thin handler that
resolves session + household and delegates to an exported
`readRandomizerPool(db, did, householdId, input)` so the DB suite can reach it
without faking a session. Validate input with zod, like `meal-plan.ts`.

All filters are applied **server-side**; the client owns the draw, re-roll and
no-repeat (§5). Changing a filter refetches the pool; rolling does not hit the
server.

### 4.1 Input (all optional, AND-combined)

```ts
{
  // scope
  source?: "box" | "corpus";   // default "box" (§4.5)
  collectionId?: string;       // draw from one collection only
  favoritesOnly?: boolean;

  // author/rendered columns
  cuisine?: string;            // §2.1 — author column OR enrichment label
  maxCookMinutes?: number;     // → total_time_seconds <= n * 60
  includeUntimed?: boolean;    // default false
  ingredient?: string;         // substring, case-insensitive

  // enrichment dimensions (§4.2)
  mealType?: string;           // breakfast|lunch|dinner|dessert|snack|side|drink
  diets?: string[];            // must be `likely` for ALL listed slugs
  avoidAllergens?: string[];   // must not be `contains`/`may_contain` for ANY
  spiceLevel?: string;         // mild|medium|hot
  proteinForward?: boolean;    // §2.4 proxy

  // the planner (§4.6)
  skipRecentDays?: number | null;  // default 14; null = don't filter
}
```

Clamp like the existing handlers: `ingredient` sliced to ~200 chars,
`maxCookMinutes` a positive finite number, `skipRecentDays` bounded (0–90),
`diets`/`avoidAllergens` capped in length, every slug bound as an opaque
parameter and never interpolated.

### 4.2 Enrichment predicates — and the one that must not be gotten wrong

Each enrichment filter is an `EXISTS` (or `NOT EXISTS`) over
`recipe_enrichment_label`, which is indexed exactly for this:
`recipe_enrichment_label_dimension_slug_verdict_idx (dimension, slug, verdict, recipe_id)`
(migration `1787679680100`).

```sql
-- diet: every requested slug must be `likely`  (AND, one EXISTS per slug)
EXISTS (SELECT 1 FROM recipe_enrichment_label l
         WHERE l.recipe_id = r.id AND l.dimension = 'diet'
           AND l.slug = $slug AND l.verdict = 'likely')

-- allergen: an EXCLUSION, not an inclusion
NOT EXISTS (SELECT 1 FROM recipe_enrichment_label l
             WHERE l.recipe_id = r.id AND l.dimension = 'allergen'
               AND l.slug = ANY($slugs)
               AND l.verdict IN ('contains','may_contain'))

-- meal_type / spice_level / cuisine-label: verdict is always 'likely' for
-- these three dimensions (migration 1787783591746's third check-constraint arm)
EXISTS (… AND l.dimension = 'meal_type' AND l.slug = $slug)
```

**The allergen filter is the one with teeth, and it is a filter, not a promise.**
`NOT EXISTS(contains|may_contain)` keeps recipes with `not_detected`, with
`unknown`, and with **no row at all** — and a recipe nothing has classified is
indistinguishable from one classified clean. That is the same asymmetry
`lib/recipe-tags.ts` enforces on the display side, where a negative allergen
claim is structurally unconstructable. This surface must not undo it:

- Call the control **"Avoid…"**, never "free of" / "safe for".
- Do **not** render an allergen chip on a drawn recipe as reassurance. The
  result pane's `RecipeTagStrip` already shows positive warnings only; that is
  the correct amount to say.
- Say the honest thing once, in helper text: "Hides recipes we've spotted this
  in. We can't promise a recipe is free of anything."

### 4.3 Coverage — a recipe with no enrichment row vanishes

Every predicate in §4.2 except the allergen one is an inclusion, so an
unenriched recipe drops out of the pool the moment any of them is active. The
pipeline is the thing that fixes that, not this feature — but the UI must not
present a coverage hole as an empty box.

`readRandomizerPool` therefore returns, alongside the pool:

```ts
{
  pool: RandomizerCard[];
  totalInScope: number;    // box (or collection) size before ANY filter
  unenrichedInScope: number; // rows with no `recipe_enrichment` row, or status <> 'ok'
}
```

and the empty/short-pool states quote it: "3 of your 40 recipes are still being
tagged." One extra aggregate query, same round trip.

### 4.4 Base query and ingredient search

Start from the `03` box join and add predicates:

```
householdScopedQuery(db, did, householdId)
  .innerJoin("household_recipe as hr", "hr.household_id", "hm.household_id")
  .innerJoin("recipe as r", "r.id", "hr.recipe_id")
  .$if(collectionId != null, q => q.innerJoin("recipe_collection_entry as rce", …))
  .$if(favoritesOnly, q => q.where("hr.favorite", "=", true))
  .$if(cuisine != null, q => q.where(eb => eb.or([
      eb("r.recipe_cuisine", "=", cuisine),
      eb.exists(labelExists(eb, "cuisine", cuisine)),
  ])))
  .$if(maxCookMinutes != null, q => includeUntimed
      ? q.where(eb => eb.or([
          eb("r.total_time_seconds", "<=", maxCookMinutes * 60),
          eb("r.total_time_seconds", "is", null),
        ]))
      : q.where("r.total_time_seconds", "<=", maxCookMinutes * 60))
  .$if(ingredient != null, q => q.where(eb => eb.exists(
      eb.selectFrom("recipe_ingredient as ri")
        .whereRef("ri.recipe_id", "=", "r.id")
        .where("ri.text", "ilike", `%${ingredient}%`)
        .select("ri.recipe_id"))))
  // + §4.2 enrichment predicates, + §4.6 recency
```

Ingredient search is a case-insensitive substring, bound as a parameter (never
interpolated), matching PRD §2.4's "contains a matching substring".
`recipe_search`'s tsvector is overkill here and would change match semantics —
plain `ILIKE` over a box-sized set is correct and cheap. Escape `%` and `_` in
the user's text so a typed `%` does not become a wildcard.

Return one lightweight card per eligible recipe — the same fields
`HouseholdRecipeRow` carries (id, title, thumb, source label via `deriveSource`,
`totalTimeDisplay`) — so the drawn card renders before the detail query lands.
Small N; no pagination.

### 4.5 Corpus widening (`source: "corpus"`)

Same predicates over `recipe WHERE visibility = 'public'` (the
`searchGlobalRecipes` base), **left-anti-joined against the box** so widening
surfaces genuinely new recipes rather than the shelf again. Gated on an
authenticated session + active household, exactly like `searchGlobalRecipes`.
Cap the pool (200) and **surface the cap** rather than truncating silently.

The result of a corpus draw is not in the box, so §7's pane cannot render it as
a `HouseholdRecipeDetail`. Render the public recipe view instead
(`routes/recipes.$id.tsx`'s shape) with one primary action — **"Add to your
box"** — and let the box actions appear after that. Say so in the copy: a recipe
you have not kept cannot go on the plan yet.

### 4.6 "Skip what we've had recently" — the planner as a filter

`meal_plan_entry` records what the household planned and when, so the randomizer
can stop suggesting Tuesday's dinner on Thursday:

```sql
NOT EXISTS (SELECT 1 FROM meal_plan_entry mpe
             WHERE mpe.household_id = $householdId
               AND mpe.recipe_id = r.id
               AND mpe.deleted_at IS NULL
               AND mpe.plan_date >= $today::date - $skipRecentDays)
```

`$today` is the household-timezone date (`todayIn(timezone)` via
`readHouseholdPreferences`), **not** `current_date` — plan dates are calendar
dates in the household's zone (planner deviation 2), and the server's zone is
the wrong clock. Bind `plan_date` comparisons as `::date` like every other
planner query.

**Default ON at 14 days.** This is the filter that most directly serves the
PRD's stated purpose, and it is the one the PRD could not have asked for. It is
also the only default that hides recipes, so the control must say what it is
doing ("Skipping 6 you've had in the last 2 weeks") and be one click to turn off.

---

## 5. Draw / re-roll / no-repeat (client, in-session)

The client holds the pool from §4 and does the random logic — instant re-rolls,
no per-roll round trip. Put the logic in a pure module
(`services/web/src/lib/randomizer/draw.ts`) so it is unit-testable without a
component.

### 5.1 Draw

"What should I make?" picks one recipe uniformly at random from the pool.

### 5.2 Re-roll

"Roll again" is an independent uniform draw from the **same** pool (filters
unchanged). No refetch.

### 5.3 No-repeat (PRD §3.3)

Track the last suggested `recipeId` in component state. Exclude it from the draw
**unless** excluding it leaves zero candidates (pool size 1 ⇒ show it again).
In-session only; not persisted.

### 5.4 Edge cases (PRD §3.4)

- **Empty pool** — not an error. "No recipes match these filters", the §4.3
  coverage line when `unenrichedInScope > 0`, a "Clear filters" button, and (if
  `source === "box"`) the widen-to-corpus affordance (§4.5).
- **Single match** — draw it directly and annotate/disable "Roll again"
  ("That's the only one that matches").

### 5.5 Clear all filters (PRD §2 closing note)

Resets every filter to its default — which is not "all empty": `skipRecentDays`
returns to 14 (§4.6) and `proteinForward` returns to OFF (§2.4). One button,
one refetch.

---

## 6. Route & UI

Build with the vendored design-system primitives (`src/components/ui/*`),
semantic tokens, `lucide-react` — same rules as `03` §2. Do **not** restyle raw
markup. Follow the `buttery-design-system` and `accessibility-compliance`
skills.

### 6.1 Where it lives — and why that is a constraint, not a preference

Make it a **child of the recipes layout route**:
`services/web/src/routes/household.recipes.randomizer.tsx`, at
`/household/recipes/randomizer`.

This is load-bearing. `DetailPane` — the component §7 reuses — reads
`useRouteContext({ from: "/household/recipes" })` for its cache partition
(deliberately, over `useActiveHouseholdId()`; see its comment) and
`useRecipesView()` for the toast queue and the picker. Both exist **only** under
that layout. Nesting gets them for free; the ledger and collections column stay
mounted to the left exactly as they do for `$id`, and the randomizer reads as a
mode of the right pane rather than a separate app.

The alternative — a top-level `/household/randomizer` — requires making
`DetailPane`'s two context reads injectable before anything can render. If the
implementer takes that path, do it as a **separate, first** refactor with the
existing box tests green, and record it in results.

### 6.2 Layout

Two stacked regions in the right pane:

1. **Controls** (sticky at the top of the pane): the filter bar, the primary
   "What should I make?" button, "Roll again", "Clear filters", the pool-size
   line ("Rolling from 14 recipes · skipping 6 from the last 2 weeks").
2. **Result**: the drawn recipe, rendered as §7's real recipe view, directly
   below.

Before the first roll, region 2 holds an empty state, not a blank. After a roll,
scroll is preserved at the controls and **focus moves to the result's heading** —
`DetailPane` already focuses its title on mount, and it is keyed by
`recipe.recipeId` at the render site, so each draw remounts it and the focus move
is free. Keep that keying.

### 6.3 Filter bar

Cuisine · meal type · diets (multi) · avoid allergens (multi) · spice · max cook
time + "include untimed" · ingredient text · collection · favourites only ·
protein-forward (§2.4) · skip-recent (§4.6) · Clear filters.

That is a lot of controls for a surface whose whole point is _fewer_ decisions.
Show the six that answer "what should I make?" inline — meal type, max time,
ingredient, cuisine, favourites, skip-recent — and put diets, allergens, spice,
collection and protein-forward behind a "More filters" disclosure that shows a
count when any are set. Selects populate from the slugs **present in the current
scope**, never the full vocabulary.

### 6.4 Nav

Flip **Randomizer** in `AppSidebar.tsx` from `soon: true` to
`to: "/household/recipes/randomizer"`, keeping the `Dices` icon.

---

## 7. The result is the real recipe view

This replaces PRD §4 and §6's "on accepting, user sees the shopping list".

When a recipe is drawn, fetch it with `householdRecipeQuery(householdId,
recipeId)` and render **`components/recipes/DetailPane`** below the controls,
keyed by `recipe.recipeId`. No new detail component, no new query, no
re-implementation of a single action.

What that gets, all of it already built and tested:

| Action               | Where it comes from                                         |
| -------------------- | ----------------------------------------------------------- |
| Add to shopping list | `AddPreviewDialog` → `previewGroceryAdd`/`commitGroceryAdd` |
| Add to meal planner  | `AddToPlanDialog` → `addMealPlanRecipes` (plus §8)          |
| Start cook mode      | `CookModeLauncher` / `CookModeOverlay`                      |
| Favourite            | `toggleRecipeFavoriteMutation`                              |
| Scale & convert      | `ScalePanel` + `RecipeScaleContext`                         |
| Tags (diet/allergen) | `RecipeTagStrip` — the same labels §4.2 filtered on         |
| Household note       | `upsertHouseholdRecipeNote`                                 |
| Full recipe / source | `SourceLink`, the `$id` link                                |

While the detail query is in flight, render the lightweight card from the pool
(§4.4) so the title and image are on screen immediately.

Two rules for the implementer:

- **Do not fork `DetailPane`.** If it needs a variant (say, a back-to-controls
  affordance), add an optional prop and default it to today's behaviour, so the
  box surface is unchanged. Any prop added must be justified in results.
- **Do not duplicate its actions in the controls region.** One "Add to shopping
  list" per screen. The only randomizer-owned action is §8's shortcut.

---

## 8. One-click "add to today's <slot>"

The PRD's accept step becomes: put this on the plan for tonight, in one click.
`AddToPlanDialog` already exists but starts closed and defaults to
today/`dinner` behind two selects — right for the recipe page, one click too
many here.

Add a primary shortcut in the controls region, beside "Roll again":
**"Add to today's dinner"**, where the slot is the **current** slot rather than
always dinner, and the date is today in the **household's** timezone.

- `getPlanToday()` already returns `{ today, timezone }` — the same call
  `AddToPlanDialog` makes. Use it; do not read the browser's date.
- Add one pure helper, `slotForHour(hour): MealSlot`, to
  `services/web/src/lib/plan/week.ts` beside `MEAL_SLOTS`, mapping the
  household-local hour to `breakfast | lunch | dinner | snack`. There is no such
  helper today (grepped). Keep it a total function with explicit boundaries and
  a test per boundary — an off-by-one here plans lunch at 4pm.
- Compute the local hour from `timezone`, not `new Date().getHours()`.
- Write through `addMealPlanRecipes` — the same server fn the dialog uses. On
  success, toast via `pushToast` with the slot and day spelled out
  ("Added to Sunday dinner"), with an action linking to `/household/plan`.
- The full `AddToPlanDialog` stays available from the result pane for any other
  day or slot. The shortcut is a shortcut, not a replacement.

---

## 9. Telemetry

Follow `lib/analytics`'s existing idiom (`useAnalytics().posthog`). Capture:
`randomizer_pool_fetched` (filter keys set, pool size, `unenrichedInScope`),
`randomizer_rolled` (roll index within the session, whether no-repeat fired),
`randomizer_result_action` (`plan_today` | `plan_dialog` | `grocery` | `cook` |
`open_recipe`), `randomizer_widened_to_corpus`, `randomizer_empty_pool` (which
filters were active).

The point of `randomizer_empty_pool` and `unenrichedInScope` together is to
answer §2.4's open question — whether protein-forward can default ON — with a
number instead of an argument.

---

## 10. Testing

- **`readRandomizerPool` (`randomizer.db.test.ts`, the `db` project)**: each
  filter in isolation and AND-combined; the allergen filter keeping
  `not_detected`, `unknown` **and** no-row recipes (the §4.2 asymmetry, asserted
  directly); `includeUntimed`; `ILIKE` case-insensitivity and `%`/`_` escaping;
  cuisine matching via the author column, via the label, and via both; the
  recency filter across the household-timezone boundary and ignoring
  soft-deleted entries; collection scoping; corpus source excluding already-boxed
  recipes and reporting the cap; `totalInScope` / `unenrichedInScope`;
  non-member and no-active-household fail closed (mirror `meal-plan.db.test.ts`'s
  scoping group).
- **Draw logic (`lib/randomizer/draw.test.ts`, unit)**: uniform draw, no-repeat
  at pool sizes 1 / 2 / N, empty and single-match states, clear-all restoring
  the non-empty defaults (§5.5).
- **`slotForHour` (unit)**: every boundary hour, both sides.
- Follow the repo's vitest project split — `*.db.test.ts` in the `db` project,
  which skips without a reachable migrated database (`pnpm test:db`).

---

## 11. Results

Per repo convention, the implementer MUST record the build in
`docs/plans/results/2026-08-30-meal-randomizer-results.md`: decisions taken,
deviations from this spec (especially the route-nesting call in §6.1 and any
`DetailPane` prop added under §7), what was and was not verified in a browser,
and the final file map.

Two numbers this spec explicitly wants back:

1. **Enrichment coverage in a real box** — what share of a household's recipes
   carry `meal_type`, `diet` and `cuisine` labels. It decides whether §2.4's
   protein-forward toggle can default ON, and whether §4.3's coverage line is a
   rare edge case or the common one.
2. **Whether "skip recent" at 14 days empties real pools.** If a small box plus
   an active plan routinely leaves nothing, the default window is wrong.

Keep this spec frozen; capture reality in the results doc.
