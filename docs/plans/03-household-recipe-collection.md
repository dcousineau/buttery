# 03 — Household recipe collection (recipes index, master–detail)

Status: **spec / pre-development**
Depends on: `01-atproto-cron-sync-service.md` (rendered `recipe` layer),
`02-households-and-private-foundation.md` (household spine + `assertMember`
chokepoint + `householdScopedQuery`).
Design handoff: `docs/designs/design_handoff_recipes_index/README.md`
(+ `screenshots/1-default.png` … `4-favorited-and-added.png`,
`AppScreen.standalone.html` for live behavior).

---

## 1. Overview

The signed-in **Recipes** screen: a two-pane master–detail browser over the
**active household's** recipe box. A dense, scannable ledger of the household's
saved recipes on the left; the full recipe rendered in the right pane the instant
a row is selected — no page transition, no scroll reset, no lost place.

Recipes are **sourced from the global (public) collection** — the rendered
`recipe` layer already synced from atproto — and **added to a household** (a
join-row insert). This project builds:

1. Two new private tables — `household_recipe` (the sparse join / "recipe box")
   and `household_recipe_note` (one shared private note per recipe).
2. The read + mutation server functions, all behind `assertMember` /
   `householdScopedQuery`.
3. The `/household/recipes` master–detail route (desktop two-pane; mobile full-screen
   list → detail), recreating the handoff design with the vendored design-system
   primitives.
4. A **global recipe picker** (the "Add" affordance) that links an existing
   public recipe into the household — this is a join insert, **not** recipe
   creation.
5. Ingredient **scale & convert** as a pure client util (ported from the
   prototype), and **jumping-off stubs** for Apron/cook-mode, shopping list, and
   meal planner.

### 1.1 In scope

- `household_recipe` + `household_recipe_note` tables (one migration).
- Ledger: search, single-select tag chips, sort (Recent / Quickest / A–Z),
  selection, empty states.
- Detail pane: title/meta, no-photo fallback + real images, ingredients with
  scale & convert, nutrition strip, method, shared private note (autosave),
  favorite toggle (household-shared), source-unavailable indicator.
- Add-to-household via a global picker (search public rendered recipes, insert
  join row, exclude already-added).
- Remove-from-household (low-key per-recipe action — see §5.6; small addition
  beyond the handoff, a box you can't prune is a bad box).
- Sidebar: **Recipes** becomes an active nav item.
- Mobile responsive collapse (not in the prototype — see §5.4).
- **Cron save-guard** in `atproto-cron-sync` (§9.1) — in scope for this project;
  the RESTRICT FK and the guard ship together.

### 1.2 Out of scope (jumping-off points only)

- **Creating** recipes (private-to-household or published to atproto). Hard; the
  next project. The `recipe.origin='local' / visibility='draft'` seam already
  exists (migration `1785300000000`).
- **Cook mode** ("Apron on") — undesigned; stub button wired to nothing.
- **Shopping list** + **Meal planner** — own future tables (`shopping_item`,
  `plan_entry`); stub buttons show a toast/no-op this round.
- **Collections / Randomizer** — remain `soon` in the nav.
- Per-member favorites or per-member notes (both decided **shared**, §4).
- Persisting the scale/units preference server-side (ephemeral this round, §5.3).
- Pagination / virtualization of the ledger (household boxes are small; §5.2).

---

## 2. Design reference

Recreate `AppScreen.standalone.html` pixel-for-pixel **using the codebase's
semantic tokens and vendored primitives** (`src/components/ui/*.tsx`), never the
literal hexes in the handoff. Compose `Button`, `Badge`, `Sidebar`, `Card`,
`Separator`, `Toast`/`useToasts`, form primitives — do not restyle raw markup to
imitate them. Icons: `lucide-react` only, the set enumerated in the handoff
(`book-open-text`, `utensils-crossed`, `external-link`, `pencil`, `clock`,
`star`, `cooking-pot`, `shopping-basket`, `calendar-range`, `check`, `settings-2`,
`eye-off`).

The handoff's "Data shape per recipe" and "State Management" tables are the
canonical description of the intended view state — this spec maps them onto real
data and persistence.

---

## 3. Data model

Two new tables. Both are **Buttery-PRIVATE** (never written to any PDS), both
descend from `household`, both are read/written ONLY behind `assertMember` and
composed through `householdScopedQuery` — the exact pattern §4.2 of the
households plan reserved for `saved_recipe` / `recipe_note`.

### 3.1 Why join-by-`recipe.id`, not the research doc's `(household_id, uri)` + snapshot

Research `05-private-vs-public-data.md` §4 proposed `_saved_recipe` keyed on
`(household_id, uri)` carrying `cid` + `title_snapshot` + `ingredients_snapshot`,
because at the time the only durable store of a recipe was the atproto record
itself — a snapshot was the only way to survive source deletion / PDS downtime.

That predates the **rendered `recipe` layer** (migration `1785300000000`). That
layer _already is_ the durable local snapshot: `recipe` + `recipe_ingredient` +
`recipe_instruction` + `recipe_image` + `recipe_keyword` + nutrition columns, all
keyed on the stable ULID `recipe.id`. Duplicating it into snapshot columns would
be redundant and would drift. So the box is a **sparse join keyed on
`recipe.id`**, and the "snapshot" requirement is satisfied by keeping the
rendered row alive (see §3.4 durability).

`cid`/`uri` version-pinning ("this recipe changed since you saved it") is **not**
built now — the household always sees the current rendered version. If per-save
version-pinning is wanted later, add `saved_cid text` to `household_recipe` and
diff against `recipe.cid`; noted, not built.

### 3.2 `household_recipe` — the recipe box

| column         | type          | notes                                                |
| -------------- | ------------- | ---------------------------------------------------- |
| `household_id` | `text`        | → `household.id` **ON DELETE CASCADE**               |
| `recipe_id`    | `text`        | → `recipe.id` **ON DELETE RESTRICT** (§3.4)          |
| `added_by_did` | `text`        | NOT NULL — from session, provenance only             |
| `added_at`     | `timestamptz` | NOT NULL default `now()` — drives "Recent" sort      |
| `favorite`     | `boolean`     | NOT NULL default `false` — **household-shared** (§4) |
| `favorited_at` | `timestamptz` | nullable — set when favorited, for future sort       |

- **PK** `(household_id, recipe_id)` — a recipe appears at most once per box;
  add is idempotent (`on conflict do nothing`).
- **Index** `(household_id)` — the ledger's one hot query. (The PK's leading
  column already covers this; add an explicit partial only if profiling wants it.)
- **Index** `(recipe_id)` — makes the RESTRICT FK check + "is this in any box"
  cheap.

### 3.3 `household_recipe_note` — shared private note

Decided **one shared note per recipe** (§4). Distinct authorization family from
the box, so its own table (not a column on `household_recipe`), per research §4
"split by resource family."

| column         | type          | notes                                                                          |
| -------------- | ------------- | ------------------------------------------------------------------------------ |
| `household_id` | `text`        | part of PK + FK                                                                |
| `recipe_id`    | `text`        | part of PK + FK                                                                |
| `author_did`   | `text`        | NOT NULL — **last editor** (shared note, so this is provenance, not ownership) |
| `body`         | `text`        | NOT NULL — empty body ⇒ row is deleted, not stored blank                       |
| `created_at`   | `timestamptz` | NOT NULL default `now()`                                                       |
| `updated_at`   | `timestamptz` | NOT NULL default `now()`, bumped on edit                                       |

- **PK** `(household_id, recipe_id)` — one note per recipe per household.
- **Composite FK** `(household_id, recipe_id)` → `household_recipe`
  `(household_id, recipe_id)` **ON DELETE CASCADE** — removing a recipe from the
  box drops its note. (This is why the note references the _join row_, not
  `recipe` directly.)
- Never published; the design's `eye-off` + "Never leaves this household" label
  is literal — no atproto write path touches this table.

### 3.4 Cache durability + the source-unavailable signal (decision Q4)

Requirement: when an added recipe's source becomes unavailable (the backing
atproto record is deleted, or turns invalid, or its repo goes away), the
household **keeps seeing its cached copy** _and_ is **shown that it's no longer
publicly available**.

**Verified cron behavior (checked before writing this — see §9 for the change
this requires).** `services/atproto-cron-sync/src/render.ts` **hard-deletes**
rendered `recipe` rows at two sites:

- `renderRecipe` (render.ts:371, `DELETE_RENDERED_SQL`) — when a record turns
  **invalid**.
- `deleteRenderedForDid` (render.ts:472) — rkeys **not seen this sweep** (deleted
  from the network / repo gone).

The **raw** layer, by contrast, **soft-deletes**: `recipe.ts:128` sets
`atproto_collection_recipe.deleted_at = now()`, keeps `validation_status`, and
resurrects (`deleted_at → null`) if the record reappears (`recipe.ts:104`). So
the raw layer is a durable availability signal; the rendered layer is not.

Design (minimal, no new `recipe` column):

1. **RESTRICT FK as a backstop.** `household_recipe.recipe_id → recipe.id ON
DELETE RESTRICT`. In normal operation it never fires, because (2) stops the
   cron from _attempting_ to delete a saved recipe. It stays as a safety net so
   no other/future delete path can silently orphan a save.

2. **Cron must not delete a saved rendered row.** Both delete sites gain a guard
   `AND NOT EXISTS (SELECT 1 FROM household_recipe hr WHERE hr.recipe_id =
recipe.id)`, so a saved recipe's rendered row (and its cascade children) is
   **left in place as the household's cache**; unseen/invalid _and_ unsaved rows
   are hard-deleted exactly as today. The `household_recipe (recipe_id)` index
   (§3.2) keeps the guard cheap. (This is the whole cron change — §9.1.)

3. **Availability is computed at read time** from the raw layer, not stored:
   - `recipe.origin = 'local'` → always available (Buttery owns it).
   - `recipe.origin = 'sync'` → LEFT JOIN `atproto_collection_recipe acr` on
     `(recipe.did, recipe.rkey)`; `unavailable = acr IS NULL OR acr.deleted_at
IS NOT NULL OR acr.validation_status <> 'valid'`. Return `unavailable` +
     `unavailable_since` (`acr.deleted_at`).

   UI: when `unavailable`, a quiet inline banner in the detail pane (Lucide
   `eye-off`/`external-link`) — _"No longer publicly available — showing your
   saved copy."_ (+ date when known) — and a small marker on the ledger row.
   Content still renders in full from the cached rendered layer.

Heavier alternative, **not** chosen: add `recipe.deleted_at`, refactor the cron
to soft-delete the rendered layer, and filter `deleted_at IS NULL` in every
public read (`listRecentRecipes`, `getRecipe`, `searchGlobalRecipes`). Cleaner
first-class signal, but far more surface across a second service and the public
browse path. Revisit only if the rendered layer needs its own soft-delete for
other reasons.

### 3.5 Migration

One new file under `services/web/src/db/migrations/`, scaffolded with
**`pnpm --filter @buttery/web db:migrate:new create_household_recipe_tables`** —
never hand-name a migration file. kysely-ctl stamps the epoch-ms prefix from
`Date.now()`; a hand-picked number drifts ahead of the wall clock and makes the
next CLI-generated migration sort _before_ an already-applied one, which Kysely
rejects as corrupted. `migrate make` opens no connection, so it works with no
database running. Fill in the generated file
following the existing conventions (frozen `Kysely<any>`, `snake_case`,
`sql\`now()\``defaults, explicit`down` in reverse order). Web owns the DDL.

---

## 4. Decisions (locked)

| Question     | Decision                                                                                                                                              | Schema/behavior impact                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Add flow     | **In scope: global picker.** "Add" opens a search over the public rendered collection; picking inserts a `household_recipe` row. Not recipe creation. | `searchGlobalRecipes` + `addRecipeToHousehold` server fns; picker UI (§5.5).        |
| Favorites    | **Household-shared.**                                                                                                                                 | `favorite boolean` column on `household_recipe`; no per-user table.                 |
| Notes        | **One shared note per recipe.**                                                                                                                       | `household_recipe_note` PK `(household_id, recipe_id)`; `author_did` = last editor. |
| Stale source | **Keep cached copy + show a "no longer publicly available" indicator.**                                                                               | RESTRICT FK + read-time availability computation (§3.4); cron coordination (§9).    |

Defaulted (not asked, stated for the record):

- **Scale/units preference** — ephemeral per browsing session (a reading
  preference, not per recipe, not persisted). Revisit persisting per-user later.
- **Mobile** — route/URL-driven full-screen detail with back nav (§5.4).
- **Apron / shopping / planner buttons** — present but stubbed (§7).
- **Ledger pagination** — none this round; load the full box, filter/sort/search
  client-side (§5.2).

---

## 5. Client — routes, panes, state

### 5.1 Route structure

Household-scoped app screens live under a new **`/household`** namespace
(singular — the household you are currently operating inside), distinct from the
existing **`/households`** (plural) management surfaces (switch, invites,
members) and from `/pantry` (the overview landing). The active household is
**session-global** (`session.active_household_id`, plan 02) — it is NOT in the
path, so the URL can never disagree with the session's active household.

- **`/household/recipes`** — new `services/web/src/routes/household.recipes.index.tsx`.
  The master–detail shell (ledger; detail pane empty-state when nothing is
  selected). Loader gates through `requireActiveHousehold()` (the §8 stale-active
  guard) exactly like `/pantry`, then loads the ledger via
  `listHouseholdRecipes()`.
- **`/household/recipes/{id}`** — `household.recipes.$id.tsx`, a **child route**
  of the ledger so the ledger stays mounted (no re-fetch, scroll/place kept) and
  the detail renders in the right pane. Path-based (not a query param):
  deep-linkable and readable. Navigating between recipes re-renders the detail in
  place and resets _the detail pane's_ scroll to top (handoff). On mobile this
  child route takes the full screen (§5.4).
- This is a **different surface** from the existing public `/recipes/{id}`
  (`recipes.$id.tsx`), which is the visibility-gated, JSON-LD/microdata **public
  SEO** page for shared links and stays as-is. `/household/recipes/{id}` carries
  household chrome (favorite, shared note, add-to-* actions) and can render an
  _unavailable_ recipe from cache. Note: these private screens are auth-gated and
  not search-indexable — "clean/shareable path" is the goal, not literal SEO.
- Default: `/household/recipes` with **no** id shows the detail empty-state
  (§5.3). Auto-selecting the first recipe is optional polish, not the default.

### 5.2 Ledger (left pane) data

`listHouseholdRecipes()` returns the whole box in one shot (small N — a family
recipe box is tens, maybe low-hundreds). Each row:

`{ recipeId, title, favorite, sourceLabel, sourceKind, sourceUrl, totalMinutes,
totalTimeDisplay, keywords[], thumbUrl, unavailable }`

- **sourceKind / sourceLabel / sourceUrl**: derived from `recipe_attribution` +
  `atproto_repo.handle` + `recipe.origin` (the handoff's web / note / handle
  glyphs map to `external-link` / `pencil` / `book-open-text`). Reuse the
  provenance logic already in `server/recipes.ts` (`deriveApp`, handle/attr
  fallback) — factor the shared bits rather than duplicating.
- **totalMinutes**: `recipe.total_time_seconds / 60` (null → sorts last under
  "Quickest", shows no trailing time).
- **keywords**: `recipe_keyword.keyword[]`.
- **thumbUrl**: primary image (ordinal 0) via `blobImageUrl`, else the no-photo
  `utensils-crossed` fallback.

Filter/sort/search happen **client-side** over this array (matches the
prototype's zero-round-trip feel):

- **Search** — case-insensitive substring across title + sourceLabel + keywords.
- **Tag chips** — single-select; `All` + every distinct keyword in first-seen
  order; composes with search (AND).
- **Sort** — Recent (`added_at` desc — note: prototype used array order; we make
  it `added_at`), Quickest (`totalMinutes` asc, nulls last), A–Z
  (`localeCompare` on title).

Virtualize only if a box exceeds ~200 rows (flag, don't build).

**Empty states (two distinct):**

- Box empty (no rows) → "Your shelf is empty" + primary CTA opening the global
  picker (§5.5). Distinct from the marketing/onboarding empties.
- Filter/search yields nothing → the handoff's "Nothing matches that." /
  "Clear the tag filter…" centered empty.

### 5.3 Detail (right pane) data + state

`getHouseholdRecipe({ recipeId })` (§6.2) returns the full rendered recipe **plus**
`favorite`, `note`, `unavailable`, `unavailableSince`, and parsed `serves`.

Per-visit view state (handoff State Management table), all client-local:

| state             | default            | drives                                       |
| ----------------- | ------------------ | -------------------------------------------- |
| `q`               | `""`               | search                                       |
| `tag`             | `"All"`            | tag chip                                     |
| `sort`            | `"recent"`         | list order                                   |
| `open` (route id) | none (empty-state) | detail pane                                  |
| `flash`           | `""`               | confirmation toast (use `Toast`/`useToasts`) |
| `scaleOpen`       | `false`            | scale panel disclosure                       |
| `factor`          | `1`                | ingredient scaling + servings count          |
| `metric`          | `false`            | unit system                                  |

`favorite` and `note` are **server-persisted**, not local — optimistic UI on top
of the mutations (§6). `factor`/`metric` are ephemeral reading prefs shared
across recipes for the session (not per recipe, not persisted).

**Detail empty state (no recipe selected).** At `/household/recipes` with no id
— the box is non-empty but nothing is chosen, or the user navigated back — the
right pane shows a centered empty state, not a blank column: Lucide
`utensils-crossed`, a "Pick a recipe from the shelf" heading, a line of muted
helper copy ("Select a recipe on the left to read it here."), and a **`+ Add`
button** opening the global picker (§5.5). This supersedes the handoff's
"auto-select the first recipe" default: default to the empty state on a cold load
at `/household/recipes`, so the invitation to select/add is always the first
thing shown. (Auto-selecting first is optional polish; the empty state is the
required behavior.) This is distinct from the **box-empty** state (§5.2), which
owns the whole screen because there is no ledger to select from.

**Nutrition strip**: per-serving values from `recipe.calories` (kcal),
`protein_content`, `carbohydrate_content`, `fat_content`. `serves` parsed as the
leading integer of `recipe.recipe_yield` (free text like "8 servings"); the
displayed servings count = `round(serves × factor)`; **per-serving values do not
change with scale** (handoff). Hide the strip / individual cells when the values
are null.

### 5.4 Mobile / responsive (not in the prototype)

Below ~1024px, collapse to a single column:

- `/household/recipes` (no id) → the ledger takes the full screen.
- `/household/recipes/{id}` → the detail takes the full screen, with a back
  affordance (breadcrumb or an `X`) that navigates to `/household/recipes` and
  returns to the ledger, scroll intact. Path-based — a detail deep link opens
  straight to the recipe on mobile.
- The nav rail is already an 18rem `Sheet` below 768px (existing `AppShell`
  behavior) — nothing new.

### 5.5 Global picker (the "Add" affordance)

`Button size="sm"` "Add" in the filter bar opens a picker (dialog/sheet from the
design system) that searches the **public** rendered collection:

- `searchGlobalRecipes({ q, limit, cursor? })` (§6.6) — tsvector/name-trgm search
  over `recipe` where `visibility='public'`, **excluding recipes already in this
  household's box**. Server-side search (the global corpus is large, unlike the
  box).
- Selecting a result calls `addRecipeToHousehold({ recipeId })`, optimistically
  prepends it to the ledger, and (optionally) selects it.
- This is the only place recipe _creation_ would eventually hang off; for now the
  picker only _links existing public recipes_. No create button.

### 5.6 Remove from box (small addition beyond the handoff)

A low-key per-recipe action (overflow menu on the ledger row or a quiet control
in the detail action row) → `removeRecipeFromHousehold({ recipeId })`. Confirm
before removing (the shared note is cascade-deleted with it). Flagged as beyond
the handoff because a box with no prune path is a trap; keep it visually quiet.

---

## 6. Server functions

All in `services/web/src/server/` (new `household-recipes.ts`, or under
`server/household/`), all `createServerFn`, all server-only (dynamic `import()`
of `getDb` etc. per the established pattern). **Every one** resolves the caller
DID via `requireSessionDid()`, the active household via the session, and gates
through `assertMember(did, householdId)` and/or `householdScopedQuery`. The
active household id comes from `session.active_household_id` (validated), **never**
a client argument.

### 6.1 `listHouseholdRecipes()` — GET

Ledger payload (§5.2). Query: `householdScopedQuery(db, did, activeHouseholdId)`
→ `innerJoin household_recipe hr on hr.household_id = hm.household_id` →
`innerJoin recipe r on r.id = hr.recipe_id` → left joins for primary image,
attribution, repo handle, and `atproto_collection_recipe` (availability) →
keywords aggregated (or a second query). The membership join _is_ the
authorization; there is no code path that returns a row for a non-member.

### 6.2 `getHouseholdRecipe({ recipeId })` — GET

Full detail for one boxed recipe. **Authorization = the box membership**, not
`visibility='public'`: it must render a recipe whose source has since gone
unavailable (that's the whole point of the cache). Steps:

1. `assertMember(did, activeHouseholdId)`.
2. Confirm a `household_recipe (activeHouseholdId, recipeId)` row exists — this is
   both the authz gate (you may only read content for recipes in _your_ box) and
   404 otherwise. Do **not** add a `visibility='public'` filter here.
3. Load the rendered recipe (reuse the `getRecipe` expansion, minus its public
   gate), + `favorite`, + the shared `note`, + availability (§3.4).

### 6.3 `addRecipeToHousehold({ recipeId })` — POST

`assertMember` → verify `recipe.id` exists **and** `visibility='public'` (you can
only _add_ a currently-public recipe; already-boxed recipes that later go private
stay via the cache) → `insert into household_recipe (…, added_by_did=did) on
conflict (household_id, recipe_id) do nothing`. Idempotent. Returns the new
ledger row.

### 6.4 `removeRecipeFromHousehold({ recipeId })` — POST

`assertMember` → `delete from household_recipe where household_id=? and
recipe_id=?` (cascades the note). Idempotent.

### 6.5 `toggleHouseholdRecipeFavorite({ recipeId })` — POST

`assertMember` → flip `favorite`, set/clear `favorited_at`. Requires the row to
exist (favoriting is only meaningful for a boxed recipe). Returns
`{ favorite }`. Shared across the household (design: the star mirrors onto the
ledger for everyone).

### 6.6 `upsertHouseholdRecipeNote({ recipeId, body })` — POST

`assertMember` → require the box row exists → `body.trim() === ""` ⇒ delete the
note row; else upsert `(household_id, recipe_id)` setting `body`, `author_did=did`
(last editor), `updated_at=now()`. Debounced autosave client-side (on
blur / idle). Returns `{ body, updatedAt }`.

### 6.7 `searchGlobalRecipes({ q, limit, cursor? })` — GET

Public-corpus search for the picker (§5.5). `recipe` where `visibility='public'`,
`q` matched via `recipe_search.search_tsv` (with `name gin_trgm` fallback for
short/fuzzy), **left-anti-joined against the caller's box** so already-added
recipes don't appear. Not household-private data, but still requires an
authenticated session. Paginated (large corpus).

### 6.8 Validation + authz notes

- All `recipeId` validators mirror `getRecipe`'s: non-empty string, length cap
  (abuse guard, not a format check), always bound as a query param.
- No handler trusts a client-supplied `householdId`; it is read from the
  validated session. (Cross-household ops are not part of this feature.)
- Errors surface as the existing `NotAMemberError` etc.; the route loader
  translates auth failures to the §8 redirects (already handled by
  `requireActiveHousehold`).

---

## 7. Jumping-off stubs

Present the affordances, wire them to nothing real (or a toast), so the design is
faithful and the next projects have obvious seams:

- **"Apron on"** (primary sticker button) — cook mode is undesigned/out of scope.
  Render it exactly per the handoff (full sticker physics, `cooking-pot`); on
  click, no-op or a "Cook mode coming soon" toast. Do **not** implement a
  full-screen cook route.
- **"Add to shopping list"** / **"Add to meal planner"** — one-shot buttons;
  on click show the handoff's confirmation chip via `Toast`/`useToasts` for
  ~2400ms ("Added to the shopping list" / "Added to this week's plan") but
  **persist nothing** (no `shopping_item` / `plan_entry` tables this round).
  Comment each as the seam for projects 04/05.
- **Sidebar** — Collections & Randomizer stay `soon`. Shopping list & Meal
  planner stay `soon` (their buttons live on the detail pane, not yet their own
  screens).

---

## 8. Navigation change

`src/components/AppSidebar.tsx`: change the **Recipes** entry from `soon: true`
to `{ label: "Recipes", icon: BookOpenText, to: "/household/recipes" }`. Active
styling (butter fill + 2px border + `pop-sm`) is currently keyed on
`isActive={pathname === entry.to}` — an **exact** match, which would go inactive
on `/household/recipes/{id}`. Change it to a prefix/`startsWith` match (or
TanStack's active-link matching) so the nav item stays active on detail routes.

---

## 9. Cross-cutting dependencies & risks

1. **Cron delete guard (must land with this migration — verified).** The
   `atproto-cron-sync` service hard-deletes rendered `recipe` rows at
   `render.ts:371` (invalid record) and `render.ts:472` (`deleteRenderedForDid`,
   rkeys not seen). With the RESTRICT FK, both would throw `23503` and break the
   sweep once a household has saved that recipe. **Required change:** add
   `AND NOT EXISTS (SELECT 1 FROM household_recipe hr WHERE hr.recipe_id =
recipe.id)` to both deletes so a saved recipe's rendered row is retained as
   cache; unsaved rows delete exactly as today. This is small and surgical (two
   WHERE clauses), but it lands in a **second service** and must ship together
   with this project's migration — the FK and the guard are a pair.
2. **`recipe` has no `deleted_at`; availability comes from the raw layer.**
   Derived from `atproto_collection_recipe` (`deleted_at` + `validation_status`),
   joined on `(did, rkey)`. Verified reliable: the raw layer soft-deletes
   (`recipe.ts:128`) and every synced `recipe` carries `did`+`rkey`;
   `origin='local'` rows are always available and skip the join.
3. **`recipe_yield` is free text.** Servings parsing (§5.3) is a leading-integer
   best-effort; when it can't parse, show the raw yield and don't scale the count.
4. **Ingredient scaling parses strings** (§10) — lossy by design; the real fix is
   structured quantities on the recipe record (future). Ship the prototype's
   rules, documented as best-effort.
5. **Favorite/note are shared and unattributed in the UI** per the design; the
   DB keeps `added_by_did` / `author_did` for provenance and a possible future
   "edited by" surface.

---

## 10. Ingredient scale & convert

Port the prototype's rules verbatim into a **pure, unit-tested** util
`src/lib/recipe-scale.ts` (no React), consumed by the detail pane:

- Parse a leading quantity from each ingredient string; no quantity ⇒ pass the
  line through unchanged.
- Accepted forms: `2`, `1.5`, `1/2`, `½`, `1¼`; unicode fractions ¼ ½ ¾ ⅓ ⅔ ⅛.
- Multiply by `factor`.
- To metric: cup ×236.6→ml, tbsp ×14.8→ml, tsp ×4.9→ml, lb ×453.6→g, oz ×28.35→g;
  metric rounds to nearest 5 (nearest 10 above 100).
- To US: g ÷28.35→oz, ml ÷236.6→cups.
- Non-convertible units ("can", "head", "sprigs", "eggs") and bare counts scale
  and re-emit verbatim.
- US display: ≥10 → whole; <10 → nearest eighth as unicode fractions (`1½`, `¾`,
  `2⅛`).
- Known gaps (document, don't fix): pluralization ("2 can coconut milk"),
  volume→mass for dry goods.

Unit tests cover each form + each conversion + the pass-through cases.

---

## 11. File plan

- `services/web/src/db/migrations/<cli-stamped>_create_household_recipe_tables.ts` —
  the two tables (§3). Created by `pnpm --filter @buttery/web db:migrate:new`, not by hand (§3.5).
- `services/web/src/db/types.ts` — regenerate / add `HouseholdRecipe`,
  `HouseholdRecipeNote` to the `DB` interface (per the repo's Kysely codegen
  convention).
- `services/web/src/server/household-recipes.ts` (or `server/household/recipes.ts`)
  — the seven server fns (§6).
- `services/web/src/lib/recipe-scale.ts` + `recipe-scale.test.ts` — scaling util.
- `services/web/src/routes/household.recipes.index.tsx` — the master–detail
  shell (ledger + detail empty-state).
- `services/web/src/routes/household.recipes.$id.tsx` — the detail child route
  (right pane on desktop, full screen on mobile).
- `services/atproto-cron-sync/src/render.ts` — add the `NOT EXISTS` save-guard to
  both `recipe` delete sites (render.ts:371, render.ts:472); §9.1. Ships with the
  migration.
- Detail/ledger/picker components under `src/components/recipes/` (ledger row,
  filter bar, detail pane, scale panel, nutrition strip, global picker,
  unavailable banner).
- `services/web/src/components/AppSidebar.tsx` — activate the Recipes entry (§8).
- Shared provenance helper factored out of `server/recipes.ts` (source kind /
  label / url) so ledger + detail + public page agree.
- Dev fixtures: seed a household box (a handful of `household_recipe` rows over
  existing synced recipes) so the screen has content in local dev.

---

## 12. Testing

- **Unit**: `recipe-scale.ts` (all forms/conversions/pass-through);
  availability computation; servings parse.
- **DB/authz**: `household_recipe` / `household_recipe_note` scoped queries only
  return rows for live members (mirror `households.db.test.ts` /
  `authz.test.ts`); add/remove/favorite/note idempotency; note cascade on remove;
  RESTRICT prevents deleting a saved `recipe`.
- **Cross-tenant**: a member of household A cannot read/mutate B's box or notes
  (the `householdScopedQuery` join is the gate — assert it).
- **Availability**: a boxed recipe whose backing `atproto_collection_recipe` is
  `deleted_at`-set still renders via `getHouseholdRecipe` and reports
  `unavailable=true`.
- **Route**: `/household/recipes` gates through `requireActiveHousehold`
  (redirects for pick/onboard); a `/household/recipes/{id}` deep link opens the
  right recipe; mobile back returns to `/household/recipes`; the public
  `/recipes/{id}` page is unaffected.

---

## 13. Acceptance criteria

1. New migration creates `household_recipe` + `household_recipe_note` with the FK
   behavior in §3 (`household` cascade, `recipe` RESTRICT, note→join cascade).
2. `/household/recipes` renders the handoff design (ledger + detail) using design-system
   primitives and semantic tokens, at parity with the screenshots.
3. Ledger search, single-select tag chips, and the three sorts work client-side;
   both ledger empty states render (box-empty, filter-no-match), **and** the
   detail pane shows its "pick a recipe" empty state with an `+ Add` button when
   no recipe is selected (§5.3).
4. Selecting a row navigates to `/household/recipes/{id}` (child route), updating
   the detail pane in place with the ledger still mounted and its scroll intact;
   the detail pane resets its own scroll. Deep-linking to
   `/household/recipes/{id}` opens the right recipe.
5. Scale & convert recomputes ingredients + servings per §10; per-serving
   nutrition is unchanged; the panel/label reflect the active setting.
6. Favorite toggles (household-shared) and mirrors onto the ledger star; the
   shared private note autosaves and is household-visible, never published.
7. "Add" opens the global picker, searches public recipes excluding already-boxed
   ones, and links a selection into the box (no recipe creation).
8. A recipe whose source went unavailable still renders its cached copy with a
   clear "no longer publicly available" indicator.
9. Apron / shopping-list / meal-planner buttons are present and stubbed (toast /
   no-op), persisting nothing.
10. Sidebar **Recipes** routes to `/household/recipes` and stays active on
    `/household/recipes/{id}` (prefix match).
11. All household-scoped reads/writes pass through `assertMember` /
    `householdScopedQuery`; cross-tenant access is impossible; tests in §12 pass.
12. Mobile collapses to full-screen ledger → full-screen detail with working
    back nav.
13. The cron save-guard (§9.1) ships with the migration: deleting a
    network-removed or invalidated recipe that a household has saved retains its
    rendered row (no `23503`, sweep succeeds); an unsaved one is deleted as
    before.

---

## 14. Deferred / next

- **04 — Recipe creation** (private-to-household drafts + publish to atproto),
  hanging off the `recipe.origin='local' / visibility='draft'` seam and the
  global picker's "Add" surface.
- **05 — Cook mode** ("Apron on"), against the `xl`/`2xl` control tier.
- **06 — Shopping list** (`shopping_item`) + **Meal planner** (`plan_entry`),
  turning the stubbed detail buttons real.
- **JSON export** extended to cover `household_recipe` + `household_recipe_note`
  (research §4 "ship export from day one" — carried as a standing debt).
- Optional: per-save version-pinning (`saved_cid`) + "recipe changed since you
  saved it"; per-user scale/units persistence.
