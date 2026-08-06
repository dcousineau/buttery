# 2026-08-06 — Meal planner (weekly plan, slot entries, shopping-list seam)

Status: **spec / pre-development**
Depends on: `02-households-and-private-foundation.md` (household spine, `assertMember`,
`householdScopedQuery`), `03-household-recipe-collection.md` (the recipe box + rendered
`recipe` layer), `05-cook-mode.md` (cook session, `onFinish`).
Design handoff: **none yet — deliberately.** This plan is UI-unopinionated; §10 is the
brief the design agent works from. No layout, grid, or component decisions are made here.

> Implementer: log outcomes to `docs/plans/results/2026-08-06-meal-planner-results.md`
> (what was built, how it was verified, deliberate deviations).

---

## 1. Overview

A **household-shared weekly meal plan**. Seven days × four fixed slots
(breakfast / lunch / dinner / snack). Each slot holds an ordered list of **entries**;
an entry is a **boxed recipe** or a **note**. Entries can be reordered and moved by
drag, marked cooked, and copied week-to-week. Recipe entries link out to the existing
recipe detail view and into cook mode. A **"Add all to shopping list"** affordance is
present but inert (feature not built).

Everything is **household-scoped and Buttery-private**: no PDS record, no lexicon, no
per-user plan. Household is the minimum privacy scope in this app — only individual
_preferences_ are user-level (§2.1).

### 1.1 In scope

1. `household_preference` — typed 1:1 side-table carrying `week_start_day` + `timezone`.
2. `meal_plan_entry` — one polymorphic table (`kind` discriminator) for recipe + note entries.
3. Pure week/date math (`lib/plan/week.ts`) + tests.
4. Server functions: read a week, add recipes (multi), add/edit a note, move/reorder,
   remove (soft), toggle cooked, copy a week.
5. `/plan` route with week navigation (`?week=YYYY-MM-DD`), functional shell only.
6. Drag-to-move/reorder within and across slots/days.
7. Cook-mode finish → **prompt** to mark a matching planned entry cooked.
8. Remove-from-box **warning** when the recipe is used in the plan (removal still allowed).
9. Cron sweep guard extended so a planned recipe's rendered row is never swept.
10. Inert "Add all to shopping list" (week scope) with a "coming soon" affordance.
11. `.ics` download of the visible week (authenticated, no public/subscription URL).

### 1.2 Out of scope (seams only)

- Shopping list itself (button is inert; §9.1).
- Collections / menus as plannable entries — `kind` is designed to absorb them (§3.3).
- Per-entry servings/scaling — explicitly deferred (§4, D5).
- Subscribable webcal feed, Google Calendar OAuth (§9.3).
- Realtime multi-user sync (§8.4).
- Any published/atproto representation of a plan (§2.1).

---

## 2. Principles that constrain this design

### 2.1 Household is the minimum privacy scope

There is no per-user meal plan and no per-user visibility inside a household. All members
of a household see and edit the same plan. Provenance columns (`created_by_did`,
`cooked_by_did`) exist for display ("marked cooked by @dan"), **not** for ownership or
authorization.

atproto has no private records, so the plan is stored **only** in Buttery's Postgres and
never enters a PDS. Data portability therefore has to come from a different direction —
calendar export (§9.3) is the first such exit, `.ics` in this plan, subscribable feeds
and Google Calendar later.

### 2.2 The membership join is the authorization

Every read goes through `householdScopedQuery(db, did, householdId)`; every write goes
through `assertMember` **and** re-checks `household_id` inside the mutating statement.
Household id always comes from `session.active_household_id`, never from a client argument
(same rule as `server/household-recipes.ts`).

### 2.3 Dates are calendar dates, not instants

An entry is planned for `2026-08-12`, not for a timestamp. `plan_date` is a Postgres
`date`. No timezone math ever touches stored entries, so DST cannot shift a meal. The
household timezone is used for exactly three things: computing "today", the cook-mode
prompt's "is this planned today", and `.ics` event times.

---

## 3. Data model

Two migrations, both Buttery-private, both descending from `household`.

### 3.1 `household_preference` — typed household-wide preferences

```
household_preference
  household_id     text        PK, FK → household.id ON DELETE CASCADE
  week_start_day   smallint    NOT NULL DEFAULT 1     -- ISO-8601: 1=Mon … 7=Sun
  timezone         text        NOT NULL DEFAULT 'UTC' -- IANA name
  created_at       timestamptz NOT NULL DEFAULT now()
  updated_at       timestamptz NOT NULL DEFAULT now()
  CHECK (week_start_day BETWEEN 1 AND 7)
```

A typed 1:1 side-table, not a key/value bag and not columns on `household`: it keeps
`household` lean, keeps values typed end-to-end through kysely-codegen, and grows by
migration (which is the point — each new preference gets a review).

**Rows are lazily created.** `getHouseholdPreferences()` returns hard-coded defaults
(`{ weekStartDay: 1, timezone: "UTC" }`) when no row exists; any write upserts. No
backfill migration, no row-per-household bookkeeping at household creation.

`timezone` is validated against `Intl.supportedValuesOf("timeZone")` on write, so a bad
value can never reach the date math.

### 3.2 `meal_plan_entry` — the one entry table

```
meal_plan_entry
  id             text        PK                       -- ULID via server/household/ids.ts
  household_id   text        NOT NULL FK → household.id ON DELETE CASCADE
  plan_date      date        NOT NULL
  slot           text        NOT NULL                 -- breakfast|lunch|dinner|snack
  kind           text        NOT NULL                 -- recipe|note  (future: collection|menu)
  position       integer     NOT NULL                 -- dense 0..n-1 within (household, date, slot)
  recipe_id      text        NULL FK → recipe.id ON DELETE RESTRICT
  body           text        NULL                     -- note text, ≤ 2000 chars
  cooked_at      timestamptz NULL
  cooked_by_did  text        NULL
  created_by_did text        NOT NULL
  created_at     timestamptz NOT NULL DEFAULT now()
  updated_at     timestamptz NOT NULL DEFAULT now()
  deleted_at     timestamptz NULL                     -- soft delete
```

Constraints:

- `CHECK (slot IN ('breakfast','lunch','dinner','snack'))`
- `CHECK (kind IN ('recipe','note'))`
- `CHECK (kind <> 'recipe' OR (recipe_id IS NOT NULL AND body IS NULL))`
- `CHECK (kind <> 'note'   OR (body IS NOT NULL AND recipe_id IS NULL))`
- **No** uniqueness on `(household_id, plan_date, slot, recipe_id)` — the same recipe may
  appear twice in a slot on purpose (double batch, two protein variants) — decision D4.

Indexes:

- `meal_plan_entry_week_idx` on `(household_id, plan_date)` `WHERE deleted_at IS NULL` —
  the week read is a single range scan.
- `meal_plan_entry_recipe_id_idx` on `(recipe_id)` — makes the `ON DELETE RESTRICT` check,
  the cron sweep guard (§7.3), and "is this recipe planned?" (§7.2) cheap.

Text `CHECK`s over Postgres enums: adding `collection`/`menu` later is a one-line
constraint swap, not an enum migration, and it matches how `recipe.origin` and
`household_member.role` are already modelled.

### 3.3 Why one table with a `kind` discriminator

Ordering is the reason. Entries of different kinds interleave inside a slot and drag-drop
reorders across them; a table-per-kind design would have to synthesize a union view and
then reconcile two `position` sequences on every drop. One table means one sequence, one
move statement, one soft-delete path.

Adding `collection`/`menu` later = extend the `kind` CHECK, add a nullable FK column, add
one branch in the CHECK pair. Existing rows are untouched.

### 3.4 `recipe_id` is FK'd to `recipe`, not to `household_recipe`

Decision D3: **removing a recipe from the box does not touch the plan.** The plan entry
points at the rendered `recipe` row — the durable local snapshot — so the card keeps
rendering and keeps linking out. `ON DELETE RESTRICT` mirrors `household_recipe`: nothing
may delete a rendered row that a plan still references.

Consequences handled elsewhere:

- Remove-from-box gets a **warning** first (§7.2).
- The cron sweep's `NOT EXISTS` guard must also consider plan entries (§7.3).
- The week read exposes `inBox: boolean` per recipe entry so the UI can offer "add back
  to your box" without a second round-trip.

### 3.5 Soft delete

`deleted_at` set, row retained (decision D6). Every read filters `deleted_at IS NULL`;
`position` reindexing ignores soft-deleted rows. Retained rows keep the FK reference alive,
which is _intentional_ — a deleted-then-restored plan must not have lost its recipe. No
purge job in v1.

### 3.6 Ordering + reindexing

`position` is a dense integer per `(household_id, plan_date, slot)`. Every mutation that
changes ordering runs in one transaction:

1. `SELECT id FROM meal_plan_entry WHERE household_id=$1 AND plan_date=$2 AND slot=$3 AND deleted_at IS NULL ORDER BY position, created_at FOR UPDATE`
2. splice the moved id into the target index (or append)
3. rewrite `position = 0..n-1` for the affected slot(s)

Row locks on the destination (and source, when different) slot serialize concurrent drops
by two household members; slot sizes are single digits, so the rewrite is trivial. A
fractional/lexorank index would avoid the rewrite but buys nothing at this scale and adds
a rebalancing failure mode.

`ORDER BY position, created_at` is the canonical read order — `created_at` breaks ties
deterministically if a rewrite is ever interrupted.

### 3.7 Migrations

Two files under `services/web/src/db/migrations/`, timestamp-prefixed after the current
max (`1786100000000`), following the existing heavily-commented style:

- `…_create_household_preference.ts`
- `…_create_meal_plan_entry.ts`

Then `pnpm --filter @buttery/web db:codegen` to regenerate `src/db/types.ts`.
Both `down()` implementations drop their table `.ifExists()`.

---

## 4. Decisions (locked)

| #   | Decision                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------- |
| D1  | Plan is **household-shared**. No per-user plans, no per-user visibility. Any live member may edit.            |
| D2  | Slots are a **fixed enum of 4**: breakfast, lunch, dinner, snack. No renaming, hiding, or custom slots in v1. |
| D3  | v1 entry kinds: **boxed recipe** + **free-text note**. Notes are slot-level only (no day/week notes).         |
| D4  | The same recipe **may** appear more than once in a slot. No uniqueness constraint.                            |
| D5  | **No** per-entry servings/scale. Shopping-list math will use base yields; scaling is a later migration.       |
| D6  | Past weeks are **fully editable**; nav is unbounded in both directions; entry removal is a **soft delete**.   |
| D7  | Buttery-**private forever**. No lexicon, no PDS write. Portability comes via calendar export (§9.3).          |
| D8  | Removing a boxed recipe still used in the plan is **allowed, after a warning**; the plan entry keeps working. |
| D9  | Cook-mode finish **prompts** ("mark as cooked?") when the recipe is planned today; never silently marks.      |
| D10 | Concurrency: optimistic UI + router invalidate + refetch-on-focus. Last-write-wins per entry. No sockets.     |
| D11 | Week start + timezone are **household preferences**, defaults Monday / UTC.                                   |
| D12 | Shopping-list button is **inert** in v1: rendered, disabled, "coming soon".                                   |
| D13 | `.ics` download of a single week ships in the final phase. No subscription URL, no OAuth.                     |

---

## 5. Week + date math (`services/web/src/lib/plan/week.ts`)

Pure, dependency-light (dayjs + `utc`/`timezone` plugins, imported from explicit `.js`
subpaths as everywhere else in the repo), fully unit-tested, **no** DB or session access.

```ts
export type MealSlot = "breakfast" | "lunch" | "dinner" | "snack";
export const MEAL_SLOTS: readonly MealSlot[]; // canonical display order

/** ISO calendar date, "YYYY-MM-DD". Never a Date object across a boundary. */
export type PlanDate = string;

/** Snap any date to the start of its week under `weekStartDay` (1=Mon…7=Sun). */
export function weekStartFor(date: PlanDate, weekStartDay: number): PlanDate;

/** The 7 dates of the week beginning `weekStart`. */
export function weekDates(weekStart: PlanDate): PlanDate[];

/** "Today" as a calendar date in the household timezone. */
export function todayIn(timezone: string): PlanDate;

/** ±n weeks from a week start. */
export function shiftWeeks(weekStart: PlanDate, n: number): PlanDate;

/** Parse + validate a `?week=` param; returns null when malformed. */
export function parseWeekParam(raw: string | undefined): PlanDate | null;
```

Rules:

- Dates cross every boundary (URL, server fn args, JSON payloads) as `YYYY-MM-DD` strings.
- The server **always** re-snaps an incoming `weekStart` with `weekStartFor` — a client
  cannot pin the grid to a mid-week offset.
- Changing `week_start_day` never migrates data: entries are keyed by date, so the grid
  simply re-buckets them.

---

## 6. Server functions (`services/web/src/server/meal-plan.ts`)

Same shape as `server/household-recipes.ts`: `createServerFn`, zod-validated input,
server-only imports (`getDb`, authz, session) pulled in through dynamic `import()` inside
each handler so the module stays client-bundle-safe.

### 6.0 Shared shapes

```ts
export interface PlanRecipeEntry {
  id: string;
  kind: "recipe";
  position: number;
  recipeId: string;
  title: string;
  thumbUrl: string | null;
  totalMinutes: number | null;
  totalTimeDisplay: string | null;
  /** Still in the household box? False ⇒ offer "add back". */
  inBox: boolean;
  unavailable: boolean; // source went unavailable; renders from cache
  unpublished: boolean; // local draft with no atproto record
  cookedAt: string | null;
  cookedByDid: string | null;
}

export interface PlanNoteEntry {
  id: string;
  kind: "note";
  position: number;
  body: string;
  cookedAt: null; // notes are never "cooked"
  createdByDid: string;
}

export type PlanEntry = PlanRecipeEntry | PlanNoteEntry;

export interface PlanDay {
  date: PlanDate;
  isToday: boolean;
  slots: Record<MealSlot, PlanEntry[]>; // always all 4 keys, possibly empty arrays
}

export interface PlanWeek {
  weekStart: PlanDate;
  weekEnd: PlanDate;
  timezone: string;
  weekStartDay: number;
  today: PlanDate;
  days: PlanDay[]; // exactly 7
  /** Distinct recipe count in the week — powers the shopping-list button's label/disabled state. */
  recipeEntryCount: number;
}
```

The server always returns all 7 days and all 4 slots, empty arrays included, so the UI
never has to synthesize the skeleton.

### 6.1 `getMealPlanWeek({ week? })` — GET

Resolves session DID + active household → preferences → `weekStart = weekStartFor(week ?? todayIn(tz), weekStartDay)`.
One `householdScopedQuery` range read over `plan_date BETWEEN weekStart AND weekStart+6`,
left-joined to `recipe` (title, primary image, total time, availability flags) and
`household_recipe` (for `inBox`). Sorted `plan_date, slot, position, created_at`, then
bucketed in JS.

### 6.2 `addMealPlanRecipes({ date, slot, recipeIds })` — POST

Multi-select add (decision: picker adds several at once). Validates each `recipeId` is in
the **caller's box** (`household_recipe`) — the only membership-scoped source of truth for
what may be planned. Appends in the given order at the tail of the slot, inside the §3.6
transaction. Duplicates are allowed (D4). Returns the created entries.

### 6.3 `addMealPlanNote({ date, slot, body })` / `updateMealPlanNote({ entryId, body })` — POST

`body` trimmed, 1–2000 chars. Empty body on update ⇒ soft-delete the entry (never store a
blank note — same rule as `household_recipe_note`). `updated_at` bumped.

### 6.4 `moveMealPlanEntry({ entryId, toDate, toSlot, toIndex })` — POST

Handles reorder-within-slot and move-across-slot/day identically: lock source and
destination slots, splice, renumber both (§3.6). `toIndex` is clamped to `[0, n]`.
Validates the entry belongs to the caller's household **and** that `toDate` is a valid
calendar date (any date — past weeks are editable, D6).

### 6.5 `removeMealPlanEntry({ entryId })` — POST

Sets `deleted_at = now()`, then renumbers the slot. Idempotent.

### 6.6 `setMealPlanEntryCooked({ entryId, cooked })` — POST

Recipe entries only (notes reject). Sets/clears `cooked_at` + `cooked_by_did`. Setting
cooked on a future-dated entry is permitted — the UI may warn, the server does not care.

### 6.7 `copyMealPlanWeek({ fromWeek, toWeek, mode })` — POST

`mode: "append" | "replace"`. Both week params are re-snapped server-side. In one
transaction:

- `replace`: soft-delete all live entries in the destination week first.
- Copy every live source entry (recipes **and** notes) to the same weekday offset in the
  destination, new ULIDs, `created_by_did` = caller, **`cooked_at`/`cooked_by_did` reset
  to null**, positions preserved (renumbered densely).
- Copying an empty week is a no-op that returns `{ copied: 0 }` rather than erroring.

### 6.8 `getPlannedUsageForRecipe({ recipeId })` — GET

Powers the remove-from-box warning (§7.2). Returns
`{ total: number, upcoming: number, nextDate: PlanDate | null }` counted over live entries,
where "upcoming" is `plan_date >= todayIn(tz)`.

### 6.9 `getCookedCandidates({ recipeId })` — GET

Powers the cook-mode prompt (§7.1). Returns the live, **not-yet-cooked** entries for that
recipe on `todayIn(tz)`: `[{ entryId, slot }]`. Empty array ⇒ no prompt.

### 6.10 Validation + authz notes

- Every handler: session DID → `session.active_household_id` → `assertMember`. Household id
  is never an argument.
- Every write re-asserts `household_id` in the `WHERE` clause, so a leaked/guessed `entryId`
  from another household affects nothing.
- `date` params: zod regex `^\d{4}-\d{2}-\d{2}$` + real-date check.
- `slot`/`kind`: zod enums mirroring the DB CHECKs.
- `recipeIds`: max 20 per call.
- Role is **not** consulted — any live member may do everything (D1).

---

## 7. Cross-feature integration

### 7.1 Cook mode → "mark as cooked?" (D9)

`CookMode.onFinish` currently clears state, captures `cook_session_completed`, and exits
(`components/recipes/cook/CookMode.tsx:194`). Add, before `handleExit()`:

1. `await getCookedCandidates({ recipeId })` (fast, indexed; failure is swallowed — cook
   mode must never block on the planner).
2. `0 candidates` → exit unchanged.
3. `≥1` → render a small confirm step listing the matching slots ("Mark **dinner** as
   cooked?"); one candidate = one confirm; several = pick which. Confirm calls
   `setMealPlanEntryCooked`.
4. Capture `meal_plan_cook_prompt_shown` / `_confirmed` / `_dismissed`.

The prompt is the _only_ coupling; cook mode remains fully usable with no plan.

### 7.2 Remove-from-box warning (D8)

`getHouseholdRecipe` (detail payload) gains `plannedUsage: { total, upcoming, nextDate } | null`
so `components/recipes/DetailPane.tsx` can render the warning without an extra round-trip
(`getPlannedUsageForRecipe` exists for any other caller).

When `upcoming > 0`, the existing remove flow shows a confirmation whose substance is:

> This recipe is on your meal plan (next: Wed, Aug 12). Your meal plan will keep working —
> the recipe stays viewable and linked. Remove it from your box anyway?

Removal then proceeds normally. **No blocking.** The plan entry keeps rendering, with
`inBox: false` so the planner can offer "add back to box".

### 7.3 Cron sweep guard (required, not optional)

`services/atproto-cron-sync/src/render.ts:334` and `:482` delete rendered recipes with
`NOT EXISTS (SELECT 1 FROM household_recipe hr WHERE hr.recipe_id = recipe.id)`. A recipe
that was removed from every box but is still planned would now hit the `RESTRICT` FK and
**fail the sweep**. Both statements must gain a second guard:

```sql
and not exists (select 1 from meal_plan_entry mpe where mpe.recipe_id = recipe.id)
```

Deliberately **not** filtered on `deleted_at` — soft-deleted entries still hold the FK
reference, so the guard must see them too. `meal_plan_entry_recipe_id_idx` keeps it cheap.

This is a hard prerequisite: shipping the table without the guard breaks the sync sweep.

### 7.4 Recipe links

Recipe entries link to `/household/recipes/$id` (box detail, `household.recipes.$id.tsx`),
not the public `/recipes/$id`, so the household note/favorite context comes along.

### 7.5 Navigation

A planner entry joins the sidebar next to Recipes; `/pantry`'s "planner-at-a-glance"
placeholder copy (`routes/pantry.tsx`) gets a link to `/plan`. Placement/labelling is the
design agent's call (§10).

---

## 8. Client

### 8.1 Route

`services/web/src/routes/plan.tsx` — `/plan?week=YYYY-MM-DD`.

- `validateSearch` with zod: `week` optional, regex-checked; invalid ⇒ dropped (falls back
  to the current week) rather than erroring.
- `loaderDeps: ({ search }) => ({ week: search.week })`, `loader: ({ deps }) => getMealPlanWeek({ data: deps })`.
- Gated by `requireActiveHousehold()` like `/pantry`.
- Week nav = search-param navigation (`shiftWeeks`), so back/forward and deep links work.
- `head`/`seo()` per the existing routes.

### 8.2 Mutations + concurrency (D10)

- Optimistic local state for add/move/remove/cooked, reconciled by
  `router.invalidate()` after the server fn resolves.
- Refetch on window focus (the plan is edited by two people on two phones in one kitchen).
- Last-write-wins per entry; no version column, no conflict UI. A stale drop can reorder
  something a partner just moved — acceptable and self-healing on the next refetch.
- Mutation failure ⇒ revert the optimistic patch + toast.

### 8.3 Drag and drop

Reorder within a slot and move across slots/days, mapping to one
`moveMealPlanEntry({ toDate, toSlot, toIndex })` call. Library choice is the
implementer's, with two hard requirements: it must expose a **keyboard-accessible**
alternative (or ship alongside an explicit "Move to…" menu), and it must not regress the
mobile touch experience. No new heavyweight dep without noting it in the results doc.

### 8.4 Not building

Polling, SSE, or websockets. If shared-editing collisions turn out to bite in practice,
15s visible-tab polling is the cheap next step.

---

## 9. Seams

### 9.1 Shopping list (D12)

Week-scoped affordance, present and **disabled**, with a "coming soon" tooltip/label. It
must already know its scope: every recipe entry in the visible week (`recipeEntryCount`
comes down with the week payload). No endpoint, no partial implementation, no per-day
variant. When the shopping-list feature lands it should be able to take
`getMealPlanWeek`'s output as-is.

### 9.2 Collections / menus

`kind` + nullable FK columns absorb them (§3.3). No speculative columns now.

### 9.3 Calendar export (D13, final phase)

`.ics` download of the visible week: `services/web/src/routes/api/plan/week[.]ics.ts`,
authenticated + household-scoped like every other read. **No** token URL, **no** public
endpoint — privacy (§2.1) means the export requires a session.

- One `VEVENT` per **recipe** entry (notes are folded into the event `DESCRIPTION` of their
  slot; a note-only slot produces one event titled by the slot).
- `UID` = `<entryId>@buttery.app` — stable, so re-importing updates rather than duplicates.
- `SUMMARY` = `"Dinner: Chicken Tikka Masala"`.
- `DESCRIPTION` = recipe URL + any notes in that slot.
- Times: per-slot default local times in the household timezone, converted to UTC `Z`
  stamps (breakfast 08:00, lunch 12:30, snack 15:00, dinner 18:30; 30-minute duration).
  Converting to UTC avoids shipping a `VTIMEZONE` block; dayjs `utc`+`timezone` plugins do
  the conversion. These defaults live in one constant, ready to become preferences later.
- Builder is a **pure function** (`lib/plan/ics.ts`) over `PlanWeek` → string, so it is unit
  testable without HTTP: CRLF line endings, 75-octet line folding, `\` `,` `;` escaping.

Google Calendar sync and a subscribable webcal feed are follow-up plans; both would need a
token model and a much harder privacy review than a session-gated download.

---

## 10. UI contract (brief for the design agent)

**This plan makes no layout decisions.** It defines only the data and behaviours a design
must satisfy. The design agent owns grid vs. list, responsive strategy, density, picker
flow, and every visual decision.

Data available per week: 7 days × 4 slots, each an ordered list of entries. Recipe entries
carry title, thumbnail, total time, cooked state + who, `inBox`, `unavailable`,
`unpublished`. Note entries carry body text and author. Week payload carries today's date,
timezone, week bounds, and recipe count.

States the design must cover:

1. Empty week; empty slot; a slot with 1 vs. many entries (no fixed cap).
2. **Note rendering: notes are printed inline.** Only long notes (guide: >140 characters)
   clamp behind a "more" affordance revealing the full text. A short note must never
   require a click.
3. Recipe entry → links to the recipe detail; also offers cook mode.
4. Cooked entries visually distinct; cooked is toggleable back off.
5. `inBox: false` entry — still fully functional, offers "add back to box".
6. `unavailable` / `unpublished` recipe badges (parity with the recipes index).
7. Today's date emphasized; past days are still editable.
8. Week navigation (prev/next/jump-to-today) and a way to trigger "copy a week".
9. The inert shopping-list affordance — visibly present, clearly not yet available.
10. Drag affordances **plus** a non-drag path to move an entry (accessibility).
11. Loading/optimistic and error/revert states for every mutation.
12. Mobile: 7 days × 4 slots does not fit a phone grid; the design agent decides the
    strategy (day paging, vertical stack, other). The route and payload support any of them.

Accessibility floor: keyboard-operable move, focus-visible affordances, `aria-live`
announcement on move/remove, no colour-only encoding of cooked state.

---

## 11. File plan

| File                                                              | Purpose                                    |
| ----------------------------------------------------------------- | ------------------------------------------ |
| `services/web/src/db/migrations/…_create_household_preference.ts` | prefs table (§3.1)                         |
| `services/web/src/db/migrations/…_create_meal_plan_entry.ts`      | entry table (§3.2)                         |
| `services/web/src/db/types.ts`                                    | regenerated via `db:codegen`               |
| `services/web/src/lib/plan/week.ts` (+ `.test.ts`)                | pure week/date math (§5)                   |
| `services/web/src/lib/plan/ics.ts` (+ `.test.ts`)                 | pure `.ics` builder (§9.3)                 |
| `services/web/src/server/household/preferences.ts`                | read-with-defaults + validated upsert      |
| `services/web/src/server/meal-plan.ts`                            | all planner server fns (§6)                |
| `services/web/src/server/meal-plan.db.test.ts`                    | DB-level tests (§12)                       |
| `services/web/src/routes/plan.tsx`                                | `/plan` route (§8.1)                       |
| `services/web/src/routes/api/plan/week[.]ics.ts`                  | authenticated `.ics` download              |
| `services/web/src/components/plan/*`                              | planner components (design agent's shapes) |
| `services/web/src/server/household-recipes.ts`                    | + `plannedUsage` on detail (§7.2)          |
| `services/web/src/components/recipes/DetailPane.tsx`              | remove-from-box warning (§7.2)             |
| `services/web/src/components/recipes/cook/CookMode.tsx`           | finish prompt (§7.1)                       |
| `services/atproto-cron-sync/src/render.ts`                        | sweep guard (§7.3)                         |
| `services/web/src/routes/pantry.tsx`, sidebar nav                 | link to `/plan` (§7.5)                     |

---

## 12. Phasing

Each phase is independently mergeable and leaves the app working.

- **P0 — Foundations.** Both migrations, codegen, `lib/plan/week.ts` + tests,
  `server/household/preferences.ts`. **Ships with §7.3's cron guard** — the guard must not
  lag the table.
- **P1 — Read path.** `getMealPlanWeek`, `/plan` route rendering a functional (undesigned)
  week, week nav, `?week=` deep links.
- **P2 — Write path.** Add recipes (multi), add/edit note, remove (soft), reorder/move,
  mark cooked. Optimistic UI + invalidate + refetch-on-focus.
- **P3 — Bulk + integrations.** Copy week, cook-mode prompt, remove-from-box warning,
  inert shopping-list affordance, sidebar/pantry links.
- **P4 — Design pass.** Replace the functional shell with the design agent's components
  against the §10 contract. No schema or server changes expected.
- **P5 — Export.** `lib/plan/ics.ts` + the `.ics` route + tests.

---

## 13. Testing

- **Pure units (vitest, no DB):** `weekStartFor` across all 7 `weekStartDay` values and
  year/month boundaries; `weekDates` length + continuity; `todayIn` across a
  UTC-vs-local-date boundary (e.g. `America/Chicago` at 23:30 local); `parseWeekParam`
  rejecting `"2026-13-40"`, `""`, garbage; `.ics` escaping, folding, CRLF, UTC conversion
  across a DST boundary.
- **DB tests** (`meal-plan.db.test.ts`, following `households.db.test.ts`):
  - a non-member's `entryId` is invisible to reads and inert to every write;
  - CHECK constraints reject `kind='recipe'` with a body, `kind='note'` with a `recipe_id`,
    and an unknown slot;
  - move within a slot and across slots leaves both slots densely numbered `0..n-1`;
  - remove soft-deletes and renumbers; a removed entry never appears in a week read;
  - copy-week resets `cooked_at`, preserves weekday offsets, and `replace` clears the
    destination first;
  - duplicate recipe in a slot is accepted (D4);
  - deleting a `recipe` row referenced by a live **or soft-deleted** plan entry raises the
    `RESTRICT` error (the guard's contract);
  - `getPlannedUsageForRecipe` counts only live entries and computes `upcoming` against the
    household timezone.
- **Manual/browser (Claude-in-Chrome), recorded in the results doc:** add two recipes +
  a note to a slot; drag across days; mark cooked; copy the week forward; remove the
  recipe from the box and confirm the plan card still renders and links; finish cook mode
  and take the prompt; download the `.ics` and import it.

---

## 14. Risks

| Risk                                                                                  | Mitigation                                                                                   |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Cron sweep starts failing on `RESTRICT` for planned-but-unboxed recipes               | §7.3 guard ships in P0 with the table; DB test asserts the FK contract                       |
| Concurrent drops by two members interleave and scramble `position`                    | `FOR UPDATE` slot locks + full renumber in one transaction (§3.6)                            |
| Timezone default `UTC` makes "today" wrong for most users until they set a preference | Defaults are visible in the UI; a later onboarding step can capture `Intl…resolvedOptions()` |
| Soft-deleted entries pin rendered recipes forever                                     | Accepted in v1; a future purge job may hard-delete entries soft-deleted > N months           |
| Drag-and-drop dep bloats the client bundle or breaks touch                            | Lazy-load the DnD layer; keyboard/menu move path is required regardless (§8.3)               |
| `.ics` slot times feel arbitrary                                                      | One constant table, promoted to preferences the first time anyone asks                       |

---

## 15. Acceptance criteria

1. `household_preference` and `meal_plan_entry` exist with every constraint and index in
   §3; `db:codegen` output is committed; `pnpm typecheck` and `pnpm test` are clean.
2. A household with no `household_preference` row plans a week with Monday start / UTC
   without error.
3. `/plan` renders the current week; `/plan?week=2026-08-10` renders the week containing
   that date, snapped to the household's week start; a malformed `week` falls back to the
   current week without an error page.
4. All 7 days × 4 slots are always present in the payload, empty slots included.
5. Adding 3 recipes in one call appends them in order; the same recipe added twice yields
   two entries.
6. A note is stored, printed inline, and editable; an empty edit removes it.
7. Drag between slots and days persists across reload; both affected slots are densely
   numbered.
8. Removing an entry hides it everywhere while the row survives with `deleted_at` set.
9. Mark-cooked round-trips and records `cooked_by_did`.
10. Copy-week reproduces recipes and notes at the same weekday offsets with cooked state
    cleared; `replace` clears the destination first.
11. Removing a planned recipe from the box shows the warning, proceeds on confirm, and the
    plan entry still renders and links out with `inBox: false`.
12. The cron sweep does not delete a rendered recipe referenced by any plan entry, including
    soft-deleted ones.
13. Finishing cook mode for a recipe planned today prompts to mark it cooked; with no match
    it exits exactly as it does today.
14. A non-member cannot read or mutate any entry in another household (covered by tests).
15. The shopping-list affordance is present, week-scoped, and inert.
16. The `.ics` download imports into a calendar with correct dates, one event per recipe
    entry, stable UIDs, and notes in the description.
17. Every mutation has an optimistic path that reverts and toasts on failure.
18. Results logged to `docs/plans/results/2026-08-06-meal-planner-results.md`.

---

## 16. Deferred / next

- Shopping list generation (the button's other half) — ingredient aggregation across a week.
- Per-entry servings/scale (D5) — a nullable `servings` column + shopping-list math.
- Collections / menus as plannable kinds (§9.2).
- Google Calendar integration and a subscribable webcal feed (§9.3).
- "What we ate" history views over `cooked_at`, and suggestions from it.
- Slot customization (rename/hide) if fixed slots prove too rigid (D2).
- Purge job for long-soft-deleted entries.
