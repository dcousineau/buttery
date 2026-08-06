# Results: Meal randomizer ("What should I make?")

Execution log for the plan at [`../2026-08-03-meal-randomizer.md`](../2026-08-03-meal-randomizer.md).

Built unattended, under `srt` sandbox, by two parallel subagents (server function +
tests; route/UI + client draw logic + nav) on branch `feat/meal-randomizer` (branched
from `feat/atproto-local-dev-publishing`; the plan doc itself was pulled in from
`feat/meal-randomizer-plan` via a manual file copy rather than a merge commit — see
`FEEDBACK.md` §1 for why). Verified via the full test suite (unit + DB-backed, the
latter run against the live local dev Postgres) and server-side curl checks.
**Not** verified in a real browser — `claude-in-chrome` tooling never registered this
run (see "What could not be verified" below and `FEEDBACK.md` §4). Read that file
before trusting this feature is visually correct.

## Summary

All of §1's in-scope items are implemented: filter bar, draw/re-roll/no-repeat,
empty/single/widen states, shopping list, copy/share, and the nav flip from `soon` to
active. `pnpm typecheck` is clean, `pnpm test` passes **132/132** (15 new for
`randomizer-draw`), and the new DB-backed suite passes **19/19** against the live local
dev Postgres. No migration — this is read-only over `03`'s tables, as specified.

## What was built (file → purpose)

| File                                                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `services/web/src/server/randomizer.ts`                    | The one new server function, `getRandomizerPool` (§4): auth-gates via `activeContext()` (duplicated from `household-recipes.ts`, matching that module's own precedent of not sharing the helper across siblings), then delegates to an exported `computeRandomizerPool(db, did, householdId, input)` for the actual box/corpus query + facets. Box query (§4.2): all filters as `$if` predicates over `householdScopedQuery`. Corpus query (§4.4): `visibility='public'`, left-anti-joined against the box, capped at 200 with `cappedAtLimit` surfaced rather than silently truncated. Facets (`cuisines`/`categories`) are always computed from the **full** box regardless of active filters/source, so the selects never shrink. |
| `services/web/src/server/randomizer.db.test.ts`            | 19 DB-backed tests (vitest, `describe.skipIf(!HAS_DB)`, same seeding/cleanup convention as `households.db.test.ts`): each filter in isolation and AND-combined, `includeUntimed` null-handling, ingredient `ILIKE` case-insensitivity, box vs. corpus, corpus excludes already-boxed, non-member fails closed (proven at the membership-join level, not via a mocked session — see deviation below).                                                                                                                                                                                                                                                                                                                                 |
| `services/web/src/lib/randomizer-draw.ts`                  | Pure client logic (§5): `drawRandom(pool, excludeId, rng?)` — uniform draw with no-repeat exclusion unless pool size is 1; `buildShareText(...)` — the plain-text copy/share format (§8). Framework-free, injectable RNG for deterministic tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `services/web/src/lib/randomizer-draw.test.ts`             | 15 unit tests: pool sizes 1/2/N, no-repeat at each size, empty pool, `buildShareText` with/without optional fields.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `services/web/src/routes/household.recipes.randomizer.tsx` | Child route at `/household/recipes/randomizer`, sibling of `$id.tsx` under the `03` master-detail shell — reuses the layout's loader-level `requireActiveHousehold` gate, no duplicated auth logic. Loader fetches the unfiltered box pool for first paint.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `services/web/src/components/recipes/Randomizer.tsx`       | The UI: filter bar (cuisine/category selects populated from server-returned facets, debounced max-cook-time + ingredient inputs, "include untimed" disabled until a max time is set, "Clear all"), draw/re-roll with no-repeat, empty/single/widen states (§5.4), a `ShoppingList` subcomponent (keyed by `recipeId` so a new draw remounts fresh rather than clearing state in an effect) reusing `getHouseholdRecipe` for ingredients + copy/share via `useRecipesView().pushToast`.                                                                                                                                                                                                                                               |
| `services/web/src/components/AppSidebar.tsx`               | Randomizer flipped from `soon: true` to `to: "/household/recipes/randomizer"`. **Also fixed a latent nav-highlight bug**: the prior `isActive` check evaluated each entry's prefix match independently, so nesting Randomizer under `/household/recipes/*` would have lit up both "Recipes" and "Randomizer" simultaneously. Replaced with a single longest-match-wins `activeTo` computed once per render — a general fix, not scoped to this feature, so it also benefits any future nested nav entry.                                                                                                                                                                                                                             |

## Verification

- `pnpm --filter @buttery/web typecheck` — clean.
- `pnpm --filter @buttery/web test` — **132/132** passed (11 files).
- `randomizer.db.test.ts` run directly against the live local dev Postgres (connection
  read from `~/.railway/develop/<project>/docker-compose.yml` — `railway run` itself
  is blocked under the sandbox, see `FEEDBACK.md` §3) — **19/19** passed.
- `web` process-compose process restarted to pick up the new route; polled
  `http://127.0.0.1:3000/` to `200`.
- `curl` against `/household/recipes/randomizer` unauthenticated → `307` to `/login`,
  confirming the loader-level auth gate works (same pattern as every other
  `/household/*` route).
- Confirmed seed data exists to exercise the feature once a human opens it: household
  "The Frushineaus" has 16 boxed recipes in the local dev DB.
- eslint/prettier clean on all new/changed files (one `react-hooks/set-state-in-effect`
  violation caught and fixed by refactoring the shopping-list fetch into the
  keyed-remount `ShoppingList` subcomponent instead of clearing state in an effect).

## What could **not** be verified

`claude-in-chrome` tooling never registered this run — `ToolSearch` for
`mcp__claude-in-chrome__*` returned nothing, and `ps` itself is denied under the
sandbox, so there was no way to self-diagnose whether Chrome/the extension was even
running. Full detail in `FEEDBACK.md` §4. Consequently:

- The actual draw/re-roll/no-repeat interaction, focus-on-draw behavior, and the
  empty/single/widen visual states have **not** been eyeballed in a real browser.
- The copy/share clipboard flow (`navigator.clipboard.writeText`) has not been
  exercised interactively.
- Responsive/mobile layout has not been checked.
- No screenshots exist for this feature, unlike `03`'s results doc.

**Before calling this feature done, a human (or a session with working browser
tooling) should sign in as `chef.test` at `http://127.0.0.1:3000/login`, open
`/household/recipes/randomizer`, and walk through**: apply each filter, draw, re-roll
(confirm no-repeat), clear all, trigger the empty state (e.g. an ingredient that
matches nothing) and the widen-to-corpus affordance, and the copy/share button.

## Notes / decisions beyond the letter of the plan

- **Route vs. mode (§6's open question)**: implemented as a route
  (`/household/recipes/randomizer`), nested as a child of the existing master-detail
  shell exactly like `$id.tsx` — not a mode toggle within `/household/recipes`. This
  matches `03`'s own established pattern (shell + `.index` + `.$id` children) and
  required no changes to the shell's loader/session-guard logic.
- **`RandomizerCard` carries `sourceLabel`, not `sourceKind`.** The UI renders plain
  source text with a conditional external-link glyph (when `sourceUrl` is present)
  rather than driving the `03` detail pane's `<SourceIcon kind>` component, since the
  server contract (fixed before either subagent started, to let them work in parallel)
  didn't carry a `kind`. Cosmetic-only; worth a follow-up if visual parity with the
  `03` ledger's source icons matters.
- **`getRandomizerPool`'s handler is a thin delegate to an exported
  `computeRandomizerPool`.** Calling a `createServerFn`-wrapped handler directly under
  vitest throws (`"No Start context found in AsyncLocalStorage"` — no harness for that
  exists in this repo's test setup), so the query logic was factored out and exported
  for the DB tests to exercise directly. Public behavior of `getRandomizerPool` is
  unchanged.
- **Non-member fails closed** is tested at the `householdScopedQuery` membership-join
  level (a DID with no membership draws an empty pool/facets), not via a mocked HTTP
  session — matches how `households.db.test.ts` itself scopes its own tests.
- Corpus-widened (not-yet-boxed) recipes return `null` from `getHouseholdRecipe` in the
  shopping-list fetch, since that function's authorization is box membership, not
  `visibility='public'`. The UI shows a "not in your box yet" message with a link to
  the recipe page — the same outcome the existing `$id` detail route already renders
  for an unboxed id, not a new failure mode this feature introduces.

## Sandbox / local-dev friction encountered

Logged in full in `FEEDBACK.md` at the repo root (git commit signing blocked, `git
fetch`/`origin` over SSH blocked, `railway run` blocked, `claude-in-chrome` +
`ps` unavailable). Net effect: everything server-side and test-verifiable was
completed and verified; nothing requiring the outer sandbox's blocked
sockets/processes (signing, `railway run`, the browser bridge) could be done directly
— worked around where a workaround existed, left uncommitted / unverified-in-browser
where it didn't, rather than bypass a stated hard constraint.
