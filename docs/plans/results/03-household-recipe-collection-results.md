# Results: Household recipe collection (recipes index, master–detail)

Execution log for the plan at [`../03-household-recipe-collection.md`](../03-household-recipe-collection.md).
Built in a single pass on branch `feature/household-recipe-collection` against a live local dev server
(Railway dev Postgres via `.env`), verified end-to-end in a real browser (Claude-in-Chrome) as each
piece landed. This document records **what was actually built**, how it was verified, and open notes.

## Summary

All 13 acceptance criteria (§13) are met and were exercised in the running app. The migration is applied
to the dev DB, `src/db/types.ts` regenerated, `pnpm typecheck` is clean across the web app **and** the
`atproto-cron-sync` service, and `pnpm test` passes **61/61** (29 new for `recipe-scale`).

## What was built (file → purpose)

| File                                                                             | Purpose                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/web/src/db/migrations/1785600000000_create_household_recipe_tables.ts` | `household_recipe` (sparse join / box) + `household_recipe_note` (shared note). `household` CASCADE, `recipe` **RESTRICT** (§3.4 backstop), note→join **CASCADE**; PKs + the `(recipe_id)` index that keeps the RESTRICT FK + cron guard cheap.                                                                                                                                               |
| `services/web/src/db/types.ts`                                                   | Regenerated via `pnpm db:codegen` — adds `HouseholdRecipe`, `HouseholdRecipeNote`, registers them in `DB`.                                                                                                                                                                                                                                                                                    |
| `services/atproto-cron-sync/src/render.ts`                                       | **Cron save-guard (§9.1).** Both `recipe` delete sites (`DELETE_RENDERED_SQL`, `deleteRenderedForDid`) gained `AND NOT EXISTS (SELECT 1 FROM household_recipe hr WHERE hr.recipe_id = recipe.id)` so a boxed recipe's rendered row is retained as the household's cache; unsaved rows delete exactly as before.                                                                               |
| `services/web/src/lib/recipe-scale.ts`                                           | Pure scale & convert util (§10), verbatim port of the prototype rules + `parseServes`. No React.                                                                                                                                                                                                                                                                                              |
| `services/web/src/lib/recipe-scale.test.ts`                                      | 29 unit tests: every quantity form, both conversion directions, metric rounding, US eighth-fractions, pass-through, `parseServes`.                                                                                                                                                                                                                                                            |
| `services/web/src/server/recipe-provenance.ts`                                   | **Shared provenance** factored out of `server/recipes.ts` (§5.2/§11): `deriveSource` (web/note/handle kind + label + url) + `shortDid`/`profileUrl`/`prettify`/`deriveApp`, so ledger + detail + public page agree.                                                                                                                                                                           |
| `services/web/src/server/recipes.ts`                                             | Refactored to import the shared helpers (no behavior change; public `/recipes/$id` page verified unaffected).                                                                                                                                                                                                                                                                                 |
| `services/web/src/server/household-recipes.ts`                                   | The seven server fns (§6): `listHouseholdRecipes`, `getHouseholdRecipe`, `addRecipeToHousehold`, `removeRecipeFromHousehold`, `toggleHouseholdRecipeFavorite`, `upsertHouseholdRecipeNote`, `searchGlobalRecipes`. Every one resolves DID from the session, the household from `session.active_household_id` (never a client arg), and gates through `assertMember` / `householdScopedQuery`. |
| `services/web/src/routes/household.recipes.tsx`                                  | Master–detail **layout** route: loads the box, keeps the ledger mounted, renders detail/empty-state in `<Outlet/>`; owns shared view state (filters, factor/metric), the global picker, and the toast queue.                                                                                                                                                                                  |
| `services/web/src/routes/household.recipes.index.tsx`                            | Detail-pane **empty state** (§5.3) — "Pick a recipe from the shelf" + `+ Add`.                                                                                                                                                                                                                                                                                                                |
| `services/web/src/routes/household.recipes.$id.tsx`                              | Detail **child** route; loads `getHouseholdRecipe` (box-membership authz, can render an unavailable recipe from cache).                                                                                                                                                                                                                                                                       |
| `services/web/src/components/recipes/`                                           | `RecipeLedger`, `LedgerRow`, empty states, `GlobalRecipePicker`, `DetailPane` (+ `NoteEditor`), `ScalePanel`, `NutritionStrip`, `UnavailableBanner`, `SourceIcon`, `context.ts`.                                                                                                                                                                                                              |
| `services/web/src/components/AppSidebar.tsx`                                     | **Recipes** activated → `/household/recipes`, active styling switched to a **prefix** match so it stays active on `/household/recipes/{id}` (§8).                                                                                                                                                                                                                                             |
| `services/web/src/components/AppShell.tsx`                                       | Added `isAppView("/household/*")`: keeps the sidebar, drops the marketing footer, pins `main` to the viewport so only the inner panes scroll (fixed-height application view).                                                                                                                                                                                                                 |

## Verification (in the running app)

| Criterion (§13)            | Evidence                                                                                                                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Migration + FK behavior | `pnpm db:migrate:up` applied `1785600000000`; codegen picked up both tables. FK/PK behavior confirmed by the cascade + RESTRICT tests below.                                                                                                         |
| 2. Design parity           | `/household/recipes` renders the handoff (ledger + detail) with design-system primitives + semantic tokens; screenshots captured (default, detail, scale, favorited, unavailable, mobile).                                                           |
| 3. Filters + empty states  | Search narrows to matches ("carbonara" → 1 row); gibberish → "Nothing matches that." empty; box-empty state ("Your shelf is empty") and the detail "Pick a recipe" empty both render.                                                                |
| 4. Child-route selection   | Row click → `/household/recipes/{id}`, detail renders in place with ledger still mounted (scroll intact); deep-link to an id opens the right recipe; detail pane resets its own scroll on change.                                                    |
| 5. Scale & convert         | Verified numerically: `8½ oz`→`480 g` at 2× metric, servings `2`→`4`, label `2× · metric`; per-serving nutrition unchanged. (Default US converts a metric-authored recipe, e.g. `240 g`→`8½ oz`.)                                                    |
| 6. Favorite + note         | Favorite toggled (server round-trip) and the star **mirrored onto the ledger row**; note autosaved — confirmed persisted in `household_recipe_note` (author_did = caller).                                                                           |
| 7. Global picker           | "Add" opens the picker; tsvector search ("chocolate cake" → 6 results); already-boxed recipes excluded; selecting links it (box 10→11) and navigates to it. Not recipe creation.                                                                     |
| 8. Unavailable source      | Soft-deleted a boxed recipe's `atproto_collection_recipe` row → detail rendered its cached copy with the banner "No longer publicly available — showing your saved copy (source removed …)" and an eye-off marker on the ledger row. Reverted after. |
| 9. Stubs                   | Apron-on / shopping / planner buttons present; each fires a 2400ms confirmation toast and persists nothing.                                                                                                                                          |
| 10. Sidebar                | Recipes routes to `/household/recipes` and stays active on `/household/recipes/{id}` (prefix match).                                                                                                                                                 |
| 11. Authz                  | Every read/write flows through `assertMember` / `householdScopedQuery`; the household id comes from the validated session, never the client.                                                                                                         |
| 12. Mobile                 | At 430px: ledger full-screen, detail full-screen with a working "← Back to the shelf"; sidebar collapses to its trigger.                                                                                                                             |
| 13. Cron save-guard        | Both delete sites carry the `NOT EXISTS household_recipe` guard; `atproto-cron-sync` typechecks clean.                                                                                                                                               |

**DB-level checks run against the dev DB:** note cascade on remove (removing the box row deleted its
note); box count round-trips (10 → 11 on add → 10 on remove); favorite flag flips with `favorited_at`.

## Notes / decisions beyond the letter of the plan

- **Tag chips.** The handoff assumes a small curated keyword vocabulary; real synced recipes carry long,
  noisy keyword lists (one recipe alone had 29). The ledger surfaces the **most shared** facets — distinct
  keywords ranked by how many recipes carry them (tie-broken first-seen), capped at 18 — so the filter bar
  stays compact and scannable. A single-recipe keyword is a poor filter anyway. (Plan §5.2 specified
  first-seen order over "every distinct keyword"; this is a usability adjustment for real data, noted here.)
- **Ingredient parsing is lossy by design (§10).** Verbatim port of the prototype. Lines whose leading
  quantity is preceded by stray whitespace or malformed scrapes (e.g. `217.5oz cans`) pass through
  unchanged — the documented best-effort behavior, not a regression.
- **Dev fixtures.** Seeded 10 `household_recipe` rows for the active household (The Frushineaus) over
  existing synced recipes with images/keywords/times, one favorite (Roast Beef) and one shared note
  (Carbonara), staggered `added_at` so "Recent" is meaningful. Fixtures were applied directly to the dev DB
  (not committed as a migration).

## Out of scope (unchanged, per §1.2 / §7)

Recipe creation, cook mode, real shopping-list / meal-planner persistence, collections/randomizer,
per-member favorites/notes, server-persisted scale prefs, ledger virtualization — all remain stubs or
future projects. The `+Add` picker is the seam project 04 hangs off; the stub detail buttons are the seams
for 05/06.
