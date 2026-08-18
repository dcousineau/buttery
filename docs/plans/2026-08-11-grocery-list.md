# 2026-08-11 — Grocery list (consolidated, aisle-grouped, mobile checklist)

Status: **spec / pre-development**
Depends on: `02-households-and-private-foundation.md` (household spine, `assertMember`,
`householdScopedQuery`), `03-household-recipe-collection.md` (the box + rendered `recipe`
layer), `2026-08-06-meal-planner.md` (plan weeks; D5/D10/D15 precedents).
Related: `2026-08-11-offline-mode.md` §17 names the shopping list as "the first feature that
should be designed offline-first from day one on top of this" — see §11.

> Implementer: log outcomes to `docs/plans/results/2026-08-11-grocery-list-results.md`
> (what was built, how it was verified, deliberate deviations, the measured match rate, and
> the Open Food Facts commit SHA the lexicon was generated from).

**The design is not specified here.** A design agent owns layout, copy, and interaction
detail. This plan specifies structure, states, and data only.

---

## 1. Overview

Buttery's pantry ships five inert shopping-list stubs on purpose: `ShoppingListTeaser`
("this is where it will live"), the `LockedFeaturesStrip` entry, `ThisWeekPanel`'s disabled
"Add all N to shopping list", `DetailPane`'s fake toast, and a `soon`-chipped sidebar entry.
Plan 03 §61 reserved the table name; meal-planner D12 shipped the button dead. This project
makes all of it real.

The feature: pull a single recipe, a plan week, several boxed recipes, or a typed item into
**one running household grocery list**, consolidated so "1 lb chicken breast" from one recipe
and "8 oz chicken breast" from another become a single row reading `1 lb 8 oz` with both
recipes named under it, grouped by aisle for a phone held in one hand in a store.

Two things make this more than a join query. **Ingredients are free text** —
`recipe_ingredient` is `(recipe_id, ordinal, text)` and there is no structured quantity
anywhere in the schema. And **aisle assignment has no off-the-shelf library** — no npm
package maps an ingredient to a grocery aisle. Both are solved here without touching the
recipe schema.

### 1.1 In scope

1. A build-time food lexicon generated from the Open Food Facts ingredients taxonomy.
2. A pure, dependency-free parse → categorize → merge engine (`src/lib/grocery/`).
3. Three tables: `grocery_list`, `grocery_item`, `grocery_item_source`.
4. Server functions: preview an add, commit an add, read the list, toggle/edit/remove items.
5. The `/household/list` route and its components, including the confirm-preview dialog.
6. Wiring every existing stub, the sidebar entry, and the acknowledgements attribution.
7. `docs/resources/OPENFOODFACTS.md`.

### 1.2 Out of scope (seams only)

- Offline capability beyond "the engine needs no network" — see §11.
- User-facing aisle corrections, manual merge/unmerge, per-household aisle order, store layouts.
- Any published/atproto representation of a list.
- Pantry / "already have it" tracking.
- Volume↔mass conversion by food density.

---

## 2. Decisions locked

| #   | Decision                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | **One running list per household.** Not per-week, not named, not ephemeral. Adding a source merges into the live list.                                                                           |
| D2  | **Parse at add time.** Quantities are parsed when a source is added and stored on grocery rows. `recipe_ingredient` is **not** migrated; the recipe schema is untouched.                         |
| D3  | Sources: single recipe · a plan week · multi-select of boxed recipes · manual free-text items. All four in v1.                                                                                   |
| D4  | **Scale is captured at add time.** The add call optionally carries a yield/factor per recipe (default 1×). Meal-planner D5 stands — no `servings` column on `meal_plan_entry`.                   |
| D5  | **Never merge across unit dimensions.** `1 lb` + `8 oz` merge. `1 lb chicken breast` + `2 chicken breasts` are **two rows**. No density-based conversion.                                        |
| D6  | Food identity is the **Open Food Facts canonical id** (`en:chicken-breast`). Lexicon-anchored matching with a normalized-string fallback; an unmatched line never merges with a matched food.    |
| D7  | **14 curated aisles**, fixed canonical order, hard-coded enum. No per-household reordering, no store layouts.                                                                                    |
| D8  | **No user corrections in v1.** No aisle override table, no merge/unmerge UI. The escape hatch is a **"group by aisle" toggle** — off gives a flat list.                                          |
| D9  | **Confirm-preview before commit.** Every recipe-derived add opens a preview of parsed rows; staples are shown but **unchecked by default**. Quantity and name are editable inline. Aisle is not. |
| D10 | **Checked items dim in place, then self-hide.** `checked_at` is set; the row leaves the default view once `checked_at` is older than the TTL (1h). Retired rows stay in the table as history.    |
| D11 | **Re-adding a food whose row is retired creates a NEW row.** No revival, no re-totalling. Enforced by a partial unique index over live rows only.                                                |
| D12 | Concurrency follows meal-planner **D10**: optimistic UI + router invalidate + refetch-on-focus, last-write-wins per item. No polling, no sockets.                                                |
| D13 | **No new feature flag.** Ships to everyone past the existing `invited` gate.                                                                                                                     |
| D14 | **Household-private forever.** No lexicon, no PDS write, no atproto representation — the same posture the meal plan took in its D7.                                                              |
| D15 | The food lexicon is **generated at build time** and checked in. **The running app calls no LLM and no external API** — the claim on `/ai-usage` stays true.                                      |
| D16 | The generated lexicon is an ODbL **derived database**: it ships with an ODbL notice and an attribution entry on `/acknowledgements`.                                                             |

---

## 3. Step 0 — internal resources docs

`docs/resources/` is a new internal-docs section (**not** `services/docs`). Its first entry,
`docs/resources/OPENFOODFACTS.md`, describes what Open Food Facts offers and links their
homepage, docs, data page, and taxonomies. Independent of everything else here.

---

## 4. The categorization engine

### 4.1 Why a generated lexicon

Every comparable app (Mealie, Plan to Eat, Paprika) ships a curated food list, because
nothing off the shelf does this. The Open Food Facts **ingredients taxonomy**
(`taxonomies/food/ingredients.txt` in `openfoodfacts/openfoodfacts-server`) supplies that
list, and supplies it better than hand-authoring would:

- **4,715 entries under 206 roots.** Each block carries a canonical English name, English
  synonyms, translations into 15+ languages, and a `< en: parent` chain.
- `en: chicken breast, chicken breast meat` sits under `< en: chicken meat` → `en: poultry`
  → `en: meat`, with CIQUAL, Ecobalyse, and carbon-footprint references attached.

The payoff: **aisles get assigned to ~100 taxonomy nodes, not to 1,500 foods.** Descendants
inherit from the nearest mapped ancestor, so coverage of the long tail comes out of the tree
rather than out of typing.

Using Open Food Facts ids as `food_slug` also makes this the identity spine for whatever
comes later — nutrition, vegan/allergen flags, localized ingredient names, barcode lookup —
instead of a slug vocabulary invented for one feature.

### 4.2 Build pipeline

`scripts/build-food-lexicon.ts`. Run by hand; output checked in.

1. Fetch `taxonomies/food/ingredients.txt` at a **pinned commit SHA**, recorded in the output.
2. Parse blocks into `{ id, parents[], names.en[] }`.
3. Apply `scripts/food-aisle-map.ts` — a hand-authored `Record<offNodeId, Aisle>` of roughly
   100 entries. Resolve each food by walking its ancestors; **nearest mapped ancestor wins**;
   nothing mapped ⇒ `other`.
4. Apply `scripts/food-staples.ts` — ids flagged `staple: true` (salt, pepper, cooking oils,
   common dried spices) and `ignore: true` (water, ice).
5. Emit `services/web/src/lib/grocery/lexicon.json`:

```jsonc
{
  "__meta": { "source": "Open Food Facts", "license": "ODbL-1.0", "sourceCommit": "…", "generatedFrom": "taxonomies/food/ingredients.txt" },
  "foods": { "en:chicken-breast": { "a": "meat_seafood", "n": ["chicken breast", "chicken breast meat"] } },
  "index": { "chicken breast": "en:chicken-breast", "chicken breasts": "en:chicken-breast" },
}
```

English names only in v1; the generator keeps the other languages behind a flag. Target
**under 100KB gzip** — prune `other`-only leaves with no synonyms if it runs over. A sibling
`lexicon.LICENSE.md` carries the ODbL notice, since JSON takes no comments.

Add `src/lib/grocery/lexicon.json` to the "Generated, never hand-edit" list in `AGENTS.md`.

### 4.3 Runtime matcher — `src/lib/grocery/categorize.ts`

Pure, dependency-free, no DB and no DOM, so the identical module runs inside a server function
and inside the browser. The lexicon arrives through a dynamic `import()` so it lands in its
own lazy chunk.

Cascade, first hit wins:

1. Normalized exact lookup in `index` (lowercased, punctuation stripped, whitespace collapsed).
2. Naive singularization, retry.
3. **Left-trim modifiers** — drop leading tokens one at a time and retry:
   `boneless skinless chicken breasts` → `skinless chicken breasts` → `chicken breasts` ✓.
4. **Head-noun suffix match** — the longest lexicon name that is a suffix of the phrase.
5. Fuzzy (dice coefficient over bigrams) at a **deliberately high threshold (≥ 0.9)**, only
   against same-first-letter candidates. Tuned to catch typos, not to guess: the failure this
   exists to avoid is merging `chicken breast` with `chicken thigh`.
6. Miss ⇒ `food_slug = null`, identity falls back to the normalized name, aisle `other`.
   **A null-slug row never merges with a slug row.**

### 4.4 Aisles — `src/lib/grocery/aisles.ts`

Fixed enum, fixed order, perimeter-first: `produce · meat_seafood · dairy_eggs · bakery ·
deli · frozen · canned_jarred · dry_goods · pantry · spices · baking · beverages · snacks ·
other`. `other` always renders last.

---

## 5. Parsing & consolidation

### 5.1 Parse — `src/lib/grocery/parse.ts`

Wraps [`parse-ingredient`](https://github.com/jakeboone02/parse-ingredient) (MIT — mixed
numbers, vulgar fractions, ranges, group headers), then applies Buttery's own cleanup: strip
parentheticals, strip trailing prep clauses after a comma (`, finely diced`), strip leading
prep participles, detect qty-less "to taste" lines. Returns
`{ quantity, quantityMax, unit, unitDim, name, note, isStaple, raw }`.

`unitDim` is `volume | mass | count`.

**Do not modify `src/lib/recipe-scale.ts`.** It serves cook mode and the detail pane and its
lossy parse is correct for that job. Its `MEASURE_UNITS` set and `TO_ML`/`TO_G` tables are the
reference for the new `src/lib/grocery/units.ts`, which normalizes to a base unit per
dimension (ml / g / count) and renders back out (`1 lb 8 oz`, `2½ cups`).

### 5.2 Merge

Two contributions merge iff **same identity** (`food_slug`, else normalized name) **and same
`unitDim`** (D5). Merging sums base-unit quantities and the display re-renders from the sum.
Ranges keep both endpoints. A contribution with no parseable quantity joins an existing row as
a source without changing the total.

### 5.3 Scale

Each source row carries `scale numeric default 1`. Contributed quantity is parsed quantity ×
scale, applied before merging. Nothing is ever written back to the recipe or the plan entry.

---

## 6. Schema

Three tables. Generate every migration with
`pnpm --filter @buttery/web db:migrate:new <snake_case_name>` — **never hand-name one** — then
`db:migrate:up` followed immediately by `db:codegen`.

```
grocery_list
  id ulid pk · household_id fk · created_at · updated_at
  unique index on (household_id)            -- exactly one live list per household

grocery_item
  id ulid pk · household_id · list_id fk
  food_slug text null            -- Open Food Facts id; null when unmatched
  name_norm text                 -- identity fallback + display key
  display_name text              -- what the user sees; editable
  aisle text                     -- resolved at insert, denormalized
  quantity numeric null · quantity_max numeric null
  unit text null · unit_dim text null       -- volume|mass|count
  is_manual boolean default false
  checked_at timestamptz null · checked_by_did text null
  created_by_did · created_at · updated_at
  -- D11: identity is unique only among LIVE rows, so a retired row never
  -- captures a new add and never revives.
  unique index (list_id, coalesce(food_slug, name_norm), coalesce(unit_dim,'')) where checked_at is null

grocery_item_source
  item_id fk · recipe_id text null · plan_entry_id text null
  scale numeric default 1
  raw_text text                  -- verbatim ingredient line, snapshotted
  quantity_base numeric null     -- this source's contribution, base units
  added_by_did · added_at
```

`aisle` is denormalized onto the row so regenerating the lexicon never silently reshuffles an
in-flight list. Aisle values are validated by a CHECK constraint mirroring `aisles.ts`, the
same pattern `meal_plan_entry_slot_check` uses.

`raw_text` is a deliberate snapshot, not a convenience: `docs/research/05-private-vs-public-data.md:196`
already called for the shopping list to survive its source going away.

**Visibility (D10).** The default read filters
`checked_at is null or checked_at > now() - interval '1 hour'`. Nothing is deleted and no cron
is required. The client filters against the load-time timestamp, so an item checked during a
session stays visible until reload.

---

## 7. Server functions — `src/server/grocery.ts`

Follows `src/server/meal-plan.ts` exactly. Each `createServerFn` is a thin wrapper that
resolves the caller DID from the server-validated session and the household from
`session.active_household_id` (**never** a client argument), gates through `assertMember`, and
delegates to a plain exported `(db, did, householdId, input)` function holding all behaviour —
so `grocery.db.test.ts` reaches the logic without faking a session. Server-only imports
(`getDb`, authz) are dynamic `import()`s inside each handler. Every write re-asserts
`household_id` in its `WHERE`.

- `previewGroceryAdd({ recipes: [{ recipeId, scale? }], planWeek? })` → parsed candidate rows
  with `isStaple`, resolved aisle, and merge-target hints. **Writes nothing.**
- `commitGroceryAdd({ rows })` → upsert against the live list (creating it if absent) and
  append `grocery_item_source` rows.
- `addManualGroceryItem({ text })` → parse + categorize, no preview step.
- `getGroceryList()` → items in canonical aisle order, each with its source recipes resolved
  to titles and ids.
- `toggleGroceryItem({ itemId, checked })`, `updateGroceryItem({ itemId, displayName?,
quantity?, unit? })`, `removeGroceryItem({ itemId })`.

---

## 8. UI

Structure only. Load the `buttery-design-system` skill and `docs/BRAND.md` before styling;
all new UI is WCAG A minimum leaning AA, with real touch targets — this is used one-handed in
a store.

- **`src/routes/household.list.tsx`** — grouped by aisle by default. The **"group by aisle"
  toggle** lives in a search param (meal-planner D15 precedent: shareable, back/forward-able,
  zero schema).
- **`src/components/grocery/`** — `GroceryList`, `AisleGroup`, `GroceryRow` (checkbox,
  quantity, name, source-recipe references), `AddPreviewDialog` (D9: per-row checkbox, staples
  unchecked, inline-editable quantity and name, an "add an item" affordance),
  `ManualItemInput`, `GroceryEmptyState`.
- Checked rows dim in place; nothing strikes through — matching `MisePhase`'s existing
  checked treatment.

Wire every stub:

| File                                        | Change                                               |
| ------------------------------------------- | ---------------------------------------------------- |
| `components/pantry/ShoppingListTeaser.tsx`  | Replaced by a real card linking to the list          |
| `components/pantry/LockedFeaturesStrip.tsx` | Drop the "Shopping list" entry                       |
| `components/AppSidebar.tsx`                 | Real link, drop the `soon` chip                      |
| `components/plan/ThisWeekPanel.tsx`         | Enable "Add all N to shopping list" → preview dialog |
| `components/recipes/DetailPane.tsx`         | Replace the fake toast with the real add flow        |
| `components/pantry/FillTheBoxCard.tsx`      | Copy references the list as shipped                  |
| `routes/acknowledgements.tsx`               | Open Food Facts + ODbL attribution                   |

Multi-select of boxed recipes (D3) rides the existing recipe-index selection surfaces — reuse
`components/ui/selectable-row.tsx` rather than inventing a picker.

---

## 9. Tests & calibration

- **Unit (`pnpm test`)** — `parse.test.ts`; `units.test.ts` (convert/merge/render round-trips);
  `categorize.test.ts` (each cascade step, plus explicit _non_-merge cases: chicken breast ≠
  chicken thigh, red onion ≠ green onion); `merge.test.ts` (the `1 lb` + `8 oz` → `1 lb 8 oz`
  case from the brief, and the `1 lb` + `2 count` → two rows case).
- **DB (`pnpm test:db`)** — `grocery.db.test.ts`: cross-household isolation on every function,
  the live-row partial unique index, D11 (retired row + re-add ⇒ two rows), TTL visibility,
  scale math.
- **Calibration**, before hand-tuning the aisle map. Boot the stack (`local-dev` skill), dump
  distinct `recipe_ingredient.text` from the dev DB — a real imported corpus already lives
  there — and run the matcher across it. **Target ≥ 90% of lines resolving to a `food_slug`.**
  The misses are the worklist for `food-aisle-map.ts` and the synonym pass. Record the measured
  rate in the results log.

Verify end to end in the browser at `http://127.0.0.1:3000` via Chrome MCP (never `localhost`,
never `curl`): add a single recipe; add a plan week; confirm the preview's staple defaults;
confirm the `lb`+`oz` consolidation renders as one row naming both recipes; check an item and
confirm it dims; reload after the TTL and confirm it is gone.

---

## 10. Phases

0. `docs/resources/OPENFOODFACTS.md`.
1. Lexicon pipeline — build script, aisle map, staples, generated `lexicon.json` + license
   file, `AGENTS.md` generated-files entry.
2. Pure engine — `parse.ts`, `units.ts`, `categorize.ts`, `aisles.ts`, `merge.ts`, unit tests.
   No DB, no React.
3. Schema + server functions + `grocery.db.test.ts`.
4. Route, components, preview dialog.
5. Wire the stubs, the sidebar, the acknowledgements attribution.
6. Calibration sweep against the real corpus; tune the aisle map and synonyms; log results.

---

## 11. Relationship to offline mode

`2026-08-11-offline-mode.md` §17 names the shopping list as "the first feature that should be
designed offline-first from day one on top of this". This plan does **not** build a service
worker, an IndexedDB cache, or a write queue, and it does not wait for one either. What it does
is stay compatible with both outcomes:

- The whole parse → categorize → merge engine is pure and dependency-free, with the lexicon
  lazy-loaded. It needs no network and no database, so it runs unchanged on a client that has
  gone offline.
- `grocery_item_source.raw_text` snapshots the ingredient line, so a list never depends on
  re-reading its source recipes.
- Reads and writes are ordinary server functions with optimistic patches (D12), which is
  precisely the shape the offline plan's port layer wraps.

If offline mode lands first, this feature adopts its queue with no schema change. If this
lands first, it is the offline plan's cleanest first candidate.

---

This document is AIL-4 — drafted by Claude Opus 5 from my direction, and reviewed before it landed.
