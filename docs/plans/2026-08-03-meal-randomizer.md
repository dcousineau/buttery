# 2026-08-03 — Meal randomizer ("What should I make?")

Status: **spec / pre-development**
Depends on:

- `01-atproto-cron-sync-service.md` — the rendered `recipe` layer (`recipe`,
  `recipe_ingredient`, `recipe_cuisine`/`recipe_category` vocab columns,
  `*_time_seconds`).
- `02-households-and-private-foundation.md` — household spine, `assertMember`,
  `householdScopedQuery`, `session.active_household_id`.
- `03-household-recipe-collection.md` — the recipe box (`household_recipe`),
  `listHouseholdRecipes`, `searchGlobalRecipes`, `deriveSource`, the
  `/household/recipes` surface and its vendored primitives.

Adapted from an external, stack-agnostic **Meal Randomizer PRD**. This spec maps
that behavior onto Buttery's real recipe data model and records the four places
the PRD did not fit cleanly, with the decisions taken (see §2).

---

## 1. Overview

A **"what should I make?"** randomizer over the **active household's recipe
box**. The user applies a few lightweight filters, hits one button, and gets a
single random recipe they can accept or re-roll — solving decision fatigue
without browsing the whole shelf.

Plan `03` §1.2 parked "Collections / Randomizer" as `soon` in the nav. This is
that project. It reuses the `03` data model wholesale — **no new tables** — and
adds one read-only server function plus a route.

### 1.1 In scope

- A `/household/recipes/randomizer` route (or a mode on the recipes surface —
  see §6): filter controls, a big "What should I make?" trigger, the drawn
  recipe card, re-roll, and a shopping-list + copy/share view.
- One new server function, `getRandomizerPool`, that applies the filters
  server-side over the household box and returns the eligible lightweight pool.
- Optional **corpus widening**: when the box pool is empty or small, offer to
  fold in matching public recipes (§4.4).
- Client-side draw / re-roll / no-repeat over the returned pool (§5).
- Shopping list (single-recipe ingredient list) + one-tap plain-text copy/share
  (§7, §8).
- **Randomizer** becomes an active nav item (was `soon`).

### 1.2 Out of scope

- Any new recipe attribute or migration (see §2.2 — protein-forward is dropped
  for v1, not schema'd).
- Multi-recipe shopping-list aggregation / dedup / aisle grouping (single recipe
  only, per PRD §4).
- Cross-session persistence of the "last suggested" recipe (in-session only; PRD
  §3.3 marks persistence a nice-to-have).
- Meal-plan calendar, nutrition tracking, authoring — all owned elsewhere.

---

## 2. PRD → data-model fit (the four gaps + decisions)

The PRD is stack-agnostic and lists illustrative fields. Buttery already has a
rich recipe model (migration `1785300000000`). Mapping was mostly clean; four
points needed a call. **All four were decided with the user** and are frozen
here.

| PRD field / behavior              | Buttery reality                                                                                                                         | Decision                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Name                              | `recipe.name`                                                                                                                           | direct                                                                                           |
| Cuisine                           | `recipe.recipe_cuisine` (closed-vocab slug via `recipe_vocab` dim `cuisine`)                                                            | direct — single-select over box's present values                                                 |
| Meal type (soup/salad/bowl/plate) | `recipe.recipe_category` closed vocab (Soup, Salad, Entree, Dinner, Side…). **No `bowl`/`plate` tokens.**                               | **§2.1** use existing category vocab as-is; bowl/plate were PRD illustrations                    |
| Cook time (min)                   | `recipe.cook_time_seconds` **and** `recipe.total_time_seconds`                                                                          | **§2.3** filter on `total_time_seconds`; null-time excluded by default, "include untimed" opt-in |
| Ingredients list                  | `recipe_ingredient(recipe_id, ordinal, text)`                                                                                           | direct — substring match via `ILIKE` (§4.3)                                                      |
| **Protein-forward flag**          | **No such column.** `protein_content` nutrition exists but is sparse/often null; `suitable_for_diet` closed vocab + open keywords exist | **§2.2** drop for v1, toggle omitted (default effectively OFF)                                   |
| Draw from "full recipe library"   | Two surfaces: household box (small, curated) vs global public corpus (huge)                                                             | **§2.4** household box, with an opt-in widen-to-corpus when the box pool is empty/small          |

### 2.1 Meal type — existing category vocab

The meal-type filter is a single-select over `recipe.recipe_category`, populated
from the distinct category slugs **present in the current box** (prettified via
`recipe-provenance.prettify` / `recipe_vocab.label`). No vocab migration. PRD's
"bowl/plate" were examples, not required tokens.

### 2.2 Protein-forward — dropped for v1

Buttery has no boolean nor a reliable derived signal for "protein is the
centerpiece, not carb-heavy." `protein_content` is too sparse to gate on, and
`suitable_for_diet` does not encode "protein-forward." The PRD wanted this
defaulted **ON**; forcing that against a signal we cannot compute would silently
empty most pools.

**v1 ships no protein-forward toggle.** When a real signal exists (a future
authoring flag, or nutrition coverage improves), revisit. This is the one
deliberate divergence from the PRD's default-ON intent — called out here so it is
not read as an omission.

> Deferred approach, if wanted later: a household-scoped override table
> (`household_recipe_flags(household_id, recipe_id, protein_forward bool)`),
> since synced recipes come from the network and are not editable by us — a flag
> on `recipe` itself could not be set for `origin='sync'` rows. Noted, not built.

### 2.3 Cook time — `total_time_seconds`, nulls excluded by default

"Max cook time" filters on `total_time_seconds` (the value the `03` box UI
already displays via `minutesDisplay`), giving a consistent number across
surfaces. When the filter is active, recipes with `total_time_seconds IS NULL`
are **excluded by default**, with an **"include untimed recipes"** checkbox that
keeps them eligible (PRD §2.3 gives latitude; the user asked for the opt-in).

### 2.4 Draw pool — household box, widen to corpus on demand

The randomizer draws from the **active household's box** — the curated "stuff we
already like" shelf, which matches the PRD's "instead of browsing the full
library" framing and is small enough for client-side draw/re-roll. When the
filtered box pool is empty or small (§4.4), the UI offers to **widen the net** to
matching public recipes from the corpus. Widening is explicit and opt-in, never
automatic.

---

## 3. No new data model

This feature is **read-only over `03`'s tables**. Nothing is migrated, nothing is
written. Authorization is the same chokepoint every box query uses:
`householdScopedQuery(db, did, householdId)` joined to `household_recipe`, with
the active household resolved from `session.active_household_id` (never a client
argument) via the `activeContext()` helper already in
`services/web/src/server/household-recipes.ts`.

---

## 4. Server function — `getRandomizerPool`

One new `createServerFn({ method: "GET" })` in `household-recipes.ts` (or a new
`randomizer.ts` sibling). It applies **all** filters server-side and returns the
eligible pool as lightweight cards; the client owns the draw, re-roll, and
no-repeat (§5). Filters change ⇒ refetch pool; rolls do not hit the server.

### 4.1 Input (all optional, AND-combined)

```ts
{
  cuisine?: string;          // recipe_cuisine slug
  category?: string;         // recipe_category slug (meal type)
  maxCookMinutes?: number;   // → total_time_seconds <= maxCookMinutes * 60
  includeUntimed?: boolean;  // default false; when maxCookMinutes set, keep null-time rows
  ingredient?: string;       // substring, case-insensitive, over recipe_ingredient.text
  source?: "box" | "corpus"; // default "box"; "corpus" = widened public draw (§4.4)
}
```

Validate/clamp like the existing handlers (`ingredient` sliced to ~200 chars,
`maxCookMinutes` a positive finite number, slugs treated as opaque bound params).

### 4.2 Box query (`source: "box"`)

Start from the `03` box join, add the filter predicates:

```
householdScopedQuery(db, did, householdId)
  .innerJoin("household_recipe as hr", "hr.household_id", "hm.household_id")
  .innerJoin("recipe as r", "r.id", "hr.recipe_id")
  // filters:
  .$if(cuisine,  q => q.where("r.recipe_cuisine", "=", cuisine))
  .$if(category, q => q.where("r.recipe_category", "=", category))
  .$if(maxCookMinutes != null, q => includeUntimed
      ? q.where(eb => eb.or([
          eb("r.total_time_seconds", "<=", maxCookMinutes * 60),
          eb("r.total_time_seconds", "is", null),
        ]))
      : q.where("r.total_time_seconds", "<=", maxCookMinutes * 60))
  .$if(ingredient, q => q.where(eb => eb.exists(
      eb.selectFrom("recipe_ingredient as ri")
        .whereRef("ri.recipe_id", "=", "r.id")
        .where("ri.text", "ilike", `%${ingredient}%`)
        .select("ri.recipe_id"))))
```

Return a lightweight card per eligible recipe (id, title, thumb, source label via
`deriveSource`, `totalTimeDisplay`) — enough to render the drawn suggestion
without a second fetch. Small N; no pagination.

### 4.3 Ingredient search

Case-insensitive substring via `ri.text ILIKE '%…%'`, bound as a parameter (never
interpolated). Matches PRD §2.4 "contains a matching substring." `recipe_search`
tsvector is overkill here and would change match semantics; plain `ILIKE` over
the small box is correct and cheap.

### 4.4 Corpus widening (`source: "corpus"`)

Same filter predicates, but over `recipe WHERE visibility = 'public'` (the
`searchGlobalRecipes` base), **left-anti-joined against the box** so widening
surfaces genuinely new recipes, not ones already on the shelf. Gated on an
authenticated session + active household, exactly like `searchGlobalRecipes`.
Cap the returned pool (e.g. 200) so a broad corpus filter can't return the world;
**log/surface the cap** if hit rather than silently truncating.

The client decides when to offer widening (§5.4): after a `source: "box"` fetch
returns 0 or a small count, show a "Roll from the whole collection instead?"
affordance that refetches with `source: "corpus"`.

---

## 5. Draw / re-roll / no-repeat (client, in-session)

The client holds the eligible pool from §4 and does the random logic — instant
re-rolls, no per-roll server round trip.

### 5.1 Draw

"What should I make?" picks one recipe uniformly at random from the pool and
displays it.

### 5.2 Re-roll

"Roll again" is an independent uniform draw from the **same** pool (filters
unchanged). No refetch.

### 5.3 No-repeat (PRD §3.3)

Track the last suggested `recipeId` in component state. Exclude it from the draw
**unless** excluding it leaves zero candidates (pool size 1 ⇒ show it again).
In-session only; not persisted.

### 5.4 Edge cases (PRD §3.4)

- **Empty pool** — no error. Show "No recipes match these filters," prompt to
  loosen, and (if `source === "box"`) offer the widen-to-corpus affordance
  (§4.4).
- **Single match** — draw it directly; disable/annotate "Roll again" (nothing
  else to offer).

### 5.5 Clear all filters (PRD §2.5)

Resets every filter to default. Since protein-forward is dropped (§2.2), "clear"
just empties cuisine/category/ingredient, unsets max cook time, and unchecks
"include untimed" — then refetches the box pool.

---

## 6. Route & UI

Recreate with the vendored design-system primitives (`src/components/ui/*`),
semantic tokens, `lucide-react` icons — same rules as `03` §2. Do **not** restyle
raw markup.

- **Route**: `/household/recipes/randomizer` (a sibling under the recipes surface;
  reuse its household-scoped loader / `requireActiveHousehold`). Implementer may
  instead make it a mode within `/household/recipes` if that composes better with
  the existing master–detail context — call it in the results doc.
- **Filter bar**: cuisine select, meal-type (category) select, max-cook-time
  control + "include untimed" checkbox, ingredient text input, "Clear all."
  Selects populate from the distinct slugs present in the current box.
- **Trigger + result**: prominent "What should I make?" button; drawn recipe as a
  card (image, title, source, total time) linking to the full `03` detail; "Roll
  again"; the empty/single/widen states from §5.4.
- **Nav**: flip **Randomizer** from `soon` to an active item.
- Follow `buttery-design-system` skill + `accessibility-compliance` (focus moves
  to the result on draw; button-disabled states announced).

---

## 7. Shopping list (PRD §4)

Once a recipe is drawn (or opened), a shopping-list view lists that recipe's
ingredients — `recipe_ingredient.text` ordered by `ordinal`, one per line. Single
recipe only: no dedup, no aisle grouping, no cross-recipe merge (out of scope,
§1.2). The `03` detail already fetches ingredients; reuse `getHouseholdRecipe`
rather than a new query where possible.

---

## 8. Copy & share (PRD §5)

One action copies a **plain-text** summary to the clipboard: recipe name + full
ingredient list, one ingredient per line, blank line separating name from list.
Cook time / source link are nice-to-have additions. No markup — must paste
cleanly into a text message. One tap: build the string, `navigator.clipboard
.writeText`, toast confirmation (`useToasts`). Format:

```
{name}

- {ingredient 1}
- {ingredient 2}
…
```

(Total time / source URL appended if present.)

---

## 9. Testing

- `getRandomizerPool`: each filter in isolation and AND-combined; `includeUntimed`
  toggling null-time inclusion; ingredient `ILIKE` case-insensitivity; box vs
  corpus source; corpus widening excludes already-boxed; non-member / no-active-
  household fails closed (mirror `household-recipes` tests).
- Client draw logic (pure, unit-testable): uniform draw, no-repeat with pool
  sizes 1 / 2 / N, empty-pool and single-match states, clear-all reset.
- Follow the repo's Kysely/test conventions (see the `03` results doc + existing
  `household-recipes` tests).

---

## 10. Results

Per repo convention, the implementer MUST record the build in
`docs/plans/results/2026-08-03-meal-randomizer-results.md` — decisions taken,
deviations from this spec (esp. the route-vs-mode call in §6), anything deferred,
and the final file map. Keep this spec frozen; capture reality in the results
doc.
