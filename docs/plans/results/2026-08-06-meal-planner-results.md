# Meal planner — build log

> Plan: [`docs/plans/2026-08-06-meal-planner.md`](../2026-08-06-meal-planner.md)
> Branch: `feat/meal-planner`
> Implemented 2026-08-06.

## Status

All five phases (P0–P4) plus the §7 integration slices are built and verified. Nothing
from §12 is left to implement. §16 ("Deferred / next") is untouched, as intended.

**Only P0 is committed** (`0e75fde feat(plan): meal planner foundations (P0)`). Everything
after it is present in the working tree — some staged, some not — but uncommitted, because
git commit signing through the 1Password SSH agent is currently failing on this machine.
That is a local tooling problem, not a code problem; the tree is complete and green.

Test state at time of writing:

```
pnpm test     → web 176 passed | 61 skipped (12 files passed | 2 skipped)
                packages/recipe-extract 4 passed
pnpm test:db  → 61 passed / 61 (2 files)   [needs the dev stack up]
tsc --noEmit  → clean, exit 0
```

The 61 skipped in `pnpm test` are the DB suites skipping themselves because there is no
`DATABASE_URL`; they are the same 61 that pass under `pnpm test:db`.

---

## What shipped, by phase

### P0 — Foundations (committed, `0e75fde`)

| File                                                              | What                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------- |
| `services/web/src/db/migrations/…_create_household_preference.ts` | 1:1 typed side-table on `household`; rows created lazily |
| `services/web/src/db/migrations/…_create_meal_plan_entry.ts`      | one polymorphic table, `kind` discriminator, CHECK pair  |
| `services/web/src/db/types.ts`                                    | regenerated via `db:codegen`                             |
| `services/web/src/lib/plan/week.ts` (+ `week.test.ts`)            | pure week/date math (§5)                                 |
| `services/web/src/server/household/preferences.ts`                | read-with-defaults + validated upsert (§6.11)            |
| `services/atproto-cron-sync/src/render.ts`                        | `PLANNED_GUARD` on both rendered-recipe deletes (§7.3)   |

`meal_plan_entry.recipe_id` references `recipe.id` with `ON DELETE RESTRICT`
(`…_create_meal_plan_entry.ts:53`), per §3.4. The cron guard ships in the same commit as
the table, as §7.3 requires.

### P1 — Read path

**Added**

- `services/web/src/lib/plan/labels.ts` (+ `labels.test.ts`) — display-label helpers
  (`SLOT_LABELS`, `formatPlanDate`, `shortDow`, `longDow`, `weekRangeLabel`, `slotDayLine`,
  `addToSlotLabel`; `weekdayName` added in P3).
- `services/web/src/components/plan/PlanEntryCard.tsx` — the shared entry card.
- `services/web/src/components/plan/PlanEntryPopover.tsx` — the per-card action list.
- `services/web/src/components/plan/PlanWeekGrid.tsx` — 7×4 grid.
- `services/web/src/components/plan/PlanDaysAgenda.tsx` — day-card agenda.
- `services/web/src/routes/plan.tsx` — the `/plan` route, `?week=&view=&panel=`.

**Changed** — `AppSidebar.tsx` (`to: "/plan"`, `soon` dropped), `routes/pantry.tsx` (links
to `/plan`), `AppShell.tsx` (`/plan` is an app view: footer-less, viewport-pinned),
`routeTree.gen.ts`.

`getMealPlanWeek` / `readMealPlanWeek` live in `services/web/src/server/meal-plan.ts` and
resolve DIDs to handles in one batched `atproto_repo` query (D17,
`server/meal-plan.ts:179–191`).

### P2 — Write path

**Added** — `components/plan/optimistic.ts` (+ `optimistic.test.ts`, 17 tests),
`components/plan/PlanActions.tsx` (context + the shared drop handlers),
`components/plan/AddEntryDialog.tsx`, `components/plan/MoveEntryDialog.tsx`.

**Changed** — `server/meal-plan.ts` gained §6.2–§6.6; the four P1 components and
`routes/plan.tsx` were wired to real mutations.

Ordering follows §3.6 exactly: `SELECT … ORDER BY position, created_at FOR UPDATE`, append,
then rewrite `position = 0..n-1` over every affected slot, in one transaction. Cross-slot
moves lock both slots in `(date, MEAL_SLOTS index)` order so two simultaneous swaps cannot
deadlock.

### P3 — Panel + integrations

**Added** — `components/plan/ThisWeekPanel.tsx` (docked aside, collapsed rail, phone sheet,
and the §6.11 preferences form) and `components/plan/CopyWeekDialog.tsx`.

**Changed** — `server/meal-plan.ts` (`copyMealPlanWeek` + `CopiedWeek`, §6.7);
`lib/plan/labels.ts` (`weekdayName`); `routes/plan.tsx` (copy-week, panel toggle, live "This
week" button, empty-week banner); `components/recipes/cook/CookMode.tsx` (§7.1 finish
prompt); `components/recipes/CookModeLauncher.tsx` (`autoOpen` / `onAutoOpenConsumed`);
`components/recipes/DetailPane.tsx`; `routes/household.recipes.$id.tsx` (`?cook=1`, §7.5);
`PlanEntryPopover.tsx` + `PlanEntryCard.tsx` (Start cook mode goes live).

### P4 — Export

- `services/web/src/lib/plan/ics.ts` (+ `ics.test.ts`, 60 cases) — pure RFC 5545 serializer.
  Exports `buildWeekIcs`, `SLOT_TIMES`, `SLOT_LABELS` (re-exported from `lib/plan/labels.ts`,
  not redeclared), `SLOT_DURATION_MINUTES`, `MIN_DURATION_MINUTES`, `MAX_DURATION_MINUTES`,
  `PRODID`, `escapeText`, `foldLine`, `utcStamp`, `httpUrl`, `eventDuration`, `entryUid`,
  `icsFilename`.
- `services/web/src/routes/api/plan/week[.]ics.ts` — session-gated download.
  401/403 as `text/plain`, `cache-control: private, no-store` on every response,
  `content-disposition: attachment; filename="buttery-meal-plan-YYYY-MM-DD.ics"`.
  Server-only deps are dynamically `import()`ed inside the handler so `pg` cannot reach the
  client graph.

The event shape (refined past §9.3 — see deviation 13):

```
BEGIN:VEVENT
UID:e1@buttery.app
DTSTAMP:20260801T091500Z
DTSTART:20260806T233000Z
DTEND:20260807T004500Z
SUMMARY:Dinner: Chicken Tikka Masala
DESCRIPTION:Buttery: https://buttery.app/recipes/rec-123\nSource: https://s
 mittenkitchen.com/2019/03/tikka/\nDouble the batch
END:VEVENT
```

- `SUMMARY` = `"<Slot label>: <recipe title>"`, using `lib/plan/labels.ts`'s `SLOT_LABELS` —
  literally the same table the grid, the agenda and the cook prompt render. A note-only slot
  keeps the bare slot label ("Lunch").
- `DTEND − DTSTART` = the recipe's `totalMinutes`, clamped to
  `[MIN_DURATION_MINUTES = 15, MAX_DURATION_MINUTES = 480]`; untimed recipes and note-only
  slots fall back to `SLOT_DURATION_MINUTES = 30`.
- `DESCRIPTION` = `Buttery: <url>`, then `Source: <url>` when the recipe's `source.url` is an
  http(s) URL, then the slot's notes — omitted entirely when all three are absent.

`lib/` does not import `server/`: `ics.ts` declares structural `IcsWeek`/`IcsDay`/`IcsEntry`
types that `PlanWeek` satisfies with no cast.

### §7 integration slices

- **§7.1 cook-mode prompt** — `CookMode.tsx`. One candidate → "Mark {slot} as cooked?";
  several → a `CheckboxRow` list, all pre-checked. Marks go out with `Promise.allSettled`
  and every failure — including `getCookedCandidates` itself — is swallowed, because cook
  mode must never be trapped by the planner. Captures `meal_plan_cook_prompt_shown` /
  `_confirmed` / `_dismissed`.
- **§7.2 remove-from-box warning** — `server/household-recipes.ts` adds
  `plannedUsage: PlannedUsage | null` to `HouseholdRecipeDetail`, fetched inside the
  existing `Promise.all` batch (8th member, no extra sequential round trip);
  `DetailPane.tsx` swaps the remove dialog's description when `upcoming > 0`. No server-side
  gate — see "Deviations" below for why none is needed.
- **§7.3 cron sweep guard** — shipped in P0.
- **§7.5 navigation** — sidebar, pantry copy, and the `?cook=1` deep link.

### Test harness (new; the repo had none)

- `services/web/vitest.config.ts` — two projects. `unit` = every `*.test.ts` except
  `*.db.test.ts`; `db` = only `*.db.test.ts`, `fileParallelism: false`, 30s timeouts.
- `services/web/src/server/meal-plan.db.test.ts` — 58 tests.
- `services/web/package.json` → `test:db`; root `package.json` → `test:db`.
- Documented in `AGENTS.md` and `README.md`. The stale AGENTS.md gotcha
  ("`pnpm test` exits 1 — no test files yet") was replaced with the skip/`test:db` rule.

---

## Acceptance criteria (§15), walked

Evidence types: **U** = unit test, **DB** = `pnpm test:db` suite, **B** = observed in
Chrome against the running dev stack (household `01KZ9TRSAT15TC4TM0JWQN864R`, signed in as
`did:plc:sk4bpxoe37dgyr3yc2qpjr57`), **C** = read in the code only.

| #   | Criterion                            | Status                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tables + constraints + codegen       | Satisfied                 | Both migrations and the regenerated `db/types.ts` are in `0e75fde`. **DB**: 8 CHECK-constraint tests (recipe-with-body, note-with-recipe_id, unknown slot, etc.). `tsc --noEmit` exit 0; `pnpm test` green.                                                                                                                                                                                                                                                                                                    |
| 2   | No prefs row → Monday/UTC            | Satisfied                 | **DB**: 3 "preference materialisation" tests — a household with no row reads the defaults and no row is written. **B**: the verification household had no `household_preference` row for most of the pass and planned normally.                                                                                                                                                                                                                                                                                |
| 3   | Week param snapping + fallback       | Satisfied                 | **U**: `parseWeekParam` rejects `"2026-13-40"`, `""`, garbage; `weekStartFor` across all 7 start days. **C**: `searchSchema` uses `.catch(undefined)` on all three params, so nothing throws. **B**: navigated Aug 3–9 / 10–16 / 17–23 and "Today". A deliberately malformed `?week=` was **not** typed into the browser — code + unit only.                                                                                                                                                                   |
| 4   | 7×4 always present                   | Satisfied                 | **DB**: 4 `readMealPlanWeek` tests assert the full grid. **B**: the panel reported "16 of 28 slots still empty" on a partly-filled week.                                                                                                                                                                                                                                                                                                                                                                       |
| 5   | 3 recipes append in order; dupes     | Satisfied                 | **DB**: add/note group (5) + a D4 duplicate test. **B**: multi-selecting three recipes into Mon Aug 3 lunch from the grid's `+ Add` wrote positions 0/1/2 in one call.                                                                                                                                                                                                                                                                                                                                         |
| 6   | Note stored, inline, editable        | Satisfied                 | **DB**: `updatePlanNote` returns `{ removed: true }` when emptied. **B**: notes were added through the dialog's note tab. The **edit-to-empty removal was not driven in the browser** — DB test only.                                                                                                                                                                                                                                                                                                          |
| 7   | Drag + Move dialog identical         | Satisfied                 | **B**: `left_click_drag` fires genuine `isTrusted: true` HTML5 drag events; verified in Postgres that `plan_date`/`slot` changed and positions stayed dense, across days and across slots. The same entry was then moved via the "Move to…" dialog with the same DB result. **DB**: 6 move tests. Both paths go through one `slotDropHandlers()`/`movePlanEntry`.                                                                                                                                              |
| 8   | Remove hides, row survives           | Satisfied                 | **DB**: 4 soft-delete tests. **B**: removal hid the card everywhere; a later copy-week row count only reconciled once `and deleted_at is null` was added to the query — soft deletes proven the hard way.                                                                                                                                                                                                                                                                                                      |
| 9   | Cooked round-trips + `cooked_by_did` | Satisfied                 | **DB**: 5 cooked-mark tests, including `cooked_by_did`. **B**: popover "Mark cooked" set `cooked_at`; the item then reads "Not cooked after all" and clears it.                                                                                                                                                                                                                                                                                                                                                |
| 10  | Copy-week offsets + replace          | Satisfied                 | **DB**: 7 copy-week tests. **B**: `append` took the target week 14 → 28 rows with the source untouched; `replace` left 14 live rows with max position 2.                                                                                                                                                                                                                                                                                                                                                       |
| 11  | Remove-from-box warning              | Satisfied                 | **B**: removing the planned "Macaroni Pie" rendered §7.2's copy verbatim, with `(next: Thu, Aug 6)` and the plan sentence bolded. Confirmed → every Macaroni Pie card still rendered, each with a **NOT IN BOX** badge, popover offered "Add back to your box", which restored it (toast "Added back to your box").                                                                                                                                                                                            |
| 12  | Sweep never deletes planned          | Satisfied                 | **DB**: 4 tests copy `PLANNED_GUARD` **verbatim** out of `services/atproto-cron-sync/src/render.ts:340` and run the real delete. 0 rows deleted while a live entry references the recipe; still 0 once that entry is soft-deleted; sweeps only when nothing references it.                                                                                                                                                                                                                                     |
| 13  | Cook-mode finish prompt              | Satisfied (partly manual) | **B**: card popover → "Start cook mode" → mise en place ("0 of 11 prepped") → "Start cooking" → "Step 5 of 5" → **Finish** → **"Mark dinner as cooked?" / "This recipe is on today's plan." / [Not this time] [Mark cooked]**. Confirming set `cooked_at`, closed cook mode and dropped `?cook`. The **no-candidate path (exits as it does today) was not driven** — it is the swallow-all branch in code.                                                                                                     |
| 14  | Non-member isolation                 | Satisfied                 | **DB**: 7 household-scoping tests — a non-member DID reads nothing and every write refuses.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 15  | Shopping affordance inert            | Satisfied                 | **C/B**: `ThisWeekPanel.tsx:121` renders `<Button disabled focusableWhenDisabled>` with "Add all {recipeEntryCount} to shopping list" and a tooltip. **B**: the button was seen in the panel, week-scoped and unclickable. The **tooltip text itself was not hovered** during the pass.                                                                                                                                                                                                                        |
| 16  | `.ics` import                        | Partly verified           | **U**: 60 cases — escaping, folding on UTF-8 octet boundaries, CRLF, UTC conversion across DST, stable UIDs, notes in `DESCRIPTION`, slot-prefixed `SUMMARY`, duration from `totalMinutes` + clamp + fallback, labelled Buttery link, http(s)-only source link. **B**: fetched `/api/plan/week.ics?week=…` and read a valid `VCALENDAR` body containing the week's entries. **Not done: importing the file into a real calendar client**, and the `Content-Disposition` filename could not be read (see gaps). |
| 17  | Optimistic path + failure toast      | Satisfied with deviation  | **U**: 17 `optimistic.test.ts` cases. **C**: `routes/plan.tsx:140–156` — failure **drops** the patch and reconciles from the loader rather than reverting it (justified below), and always pushes a destructive toast. `copyMealPlanWeek` and "Add back to your box" are deliberately non-optimistic. **A forced-failure run was not driven in the browser.**                                                                                                                                                  |
| 18  | Panel counts + no refetch            | Satisfied                 | **B**: all three lines correct and live ("9 recipes", "16 of 28 slots still empty", "Nothing marked cooked yet."); the collapsed rail's `This week · N` tracked it. **C**: `loaderDeps: ({ search }) => ({ week: search.week })` — view/panel are not deps, so a toggle cannot refetch. **The no-refetch claim was not measured in the network tab**; it is structural.                                                                                                                                        |
| 19  | Empty-week banner                    | Satisfied                 | **B**: on the empty Aug 17–23, the banner appeared and "Copy last week in" wrote 14 rows; the banner is absent on weeks with entries (`isEmpty = week.emptySlotCount === 28`).                                                                                                                                                                                                                                                                                                                                 |
| 20  | Preferences re-snap + persist        | Satisfied                 | **B**: changing week start re-bucketed the grid with **no** `plan_date` changed in Postgres, exactly as the panel's copy promises. Pacific/Auckland moved "today" from Aug 6 to Aug 7. Both survived a reload.                                                                                                                                                                                                                                                                                                 |
| 21  | Below `md`: days only                | Satisfied at 606px        | **B** at 606px: the Week/Days toggle is absent from the DOM (`hidden … md:flex`, `routes/plan.tsx:309`) and the agenda is the only view. **C**: `useIsMobile()` forces the effective view without rewriting the URL, so `?view=week` is overridden rather than erased. **Not run below 606px** (see gaps); the `?view=week`-at-phone-width case was not typed explicitly.                                                                                                                                      |
| 22  | Note clamp at ~140                   | Satisfied (code + unit)   | **C**: `NOTE_CLAMP = 140` in `PlanEntryCard.tsx:35`; shorter notes render with no affordance, longer ones clamp with an inline `more`/`less` that `stopPropagation`s so it does not open the popover. **The more/less toggle was not clicked in the browser pass.**                                                                                                                                                                                                                                            |
| 23  | Results logged                       | Satisfied                 | This document.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

---

## Deliberate deviations

1. **Zod validators on every planner server fn.** Older server modules hand-roll their
   argument checks; `server/meal-plan.ts` uses `.validator((data: unknown) => z.object({…}).parse(data))`
   throughout. It is stricter, it is the shape the newer modules already use, and the
   parsed types feed straight into the extracted `(db, did, householdId, input)` functions.

2. **No global `pg` type parser for OID 1082.** Registering one would change how _every_
   `date` column in the app deserialises. Instead every read of `plan_date` goes out as
   `to_char(mpe.plan_date, 'YYYY-MM-DD')` and every write binds a parameter cast `::date`
   (`server/meal-plan.ts:346–351, 362, 495, 532, 975`). Without this the driver hands back
   a JS `Date` at local midnight — the instant-vs-calendar-date confusion §2.3 exists to
   prevent. A date is a `YYYY-MM-DD` string end to end.

3. **The timezone control is a grouped native `<select>` with `<optgroup>` per IANA area**,
   not a searchable combobox. §10.3 delegated this. Reasons in order: no new DS primitive is
   permitted and `components/ui/` has no combobox; a native select already has type-ahead,
   so "searchable" is free with no custom ARIA to get wrong; phones render the platform
   picker, which handles ~400 entries better than any listbox we would write; and it cannot
   drift from the "Week starts" select beside it. Option labels drop the area prefix and
   underscores ("America" ▸ "New York"); zones with no `/` land in a trailing "Other" group.
   A saved zone the platform no longer lists is appended so it stays selectable — otherwise
   saving the _week start_ would silently rewrite the timezone.
   The ~400 `<option>`s render **only after hydration** (a module-scope
   `useSyncExternalStore` gate): server and browser ICU data need not agree, and a mismatched
   option list is a hydration error. SSR emits just the saved zone.

4. **Phone density for the days agenda** (the other §10.3 delegation) and the `md`
   breakpoint. Two breakpoints, on purpose: `sm` (640px) for density, `md` (768px,
   `useIsMobile`) for D16's view switch. Below `sm` each day card is one column — day name /
   date / today badge on one baseline-aligned row above the slots, each slot label above its
   own entries — and `min-w-[30rem]` only applies from `sm`, so a 360px screen never scrolls
   sideways. D16 is implemented by forcing the effective view, not by rewriting the URL, so
   rotating a tablet back to landscape restores the chosen view. Consequence: `useIsMobile`
   returns `false` during SSR, so a phone's first paint is the week grid and it swaps on
   hydration — the same behaviour the existing sidebar already has.

5. **Native HTML5 drag-and-drop. No new dependency was added.** §14 anticipated a DnD
   library and budgeted for lazy-loading it; none was needed. `git diff HEAD -- package.json
services/web/package.json` shows **only** the two `test:db` script lines — no dependency
   changes anywhere in the tree. Cards are `draggable` and set `text/plain` to the entry id;
   `dragover` only `preventDefault()`s when _we_ started the drag, so dragging a file over
   the planner does not light up 28 slots, and `dragleave` ignores moves onto child nodes.

6. **The week grid's floor is `min-w-[46rem]`, down from the comp's `min-width: 60rem`.** At
   60rem every laptop under ~1360px — and _any_ width with the "This week" panel docked —
   got a horizontal scrollbar. At 46rem a day column is ~93px, which still holds two clamped
   lines of the 11px card title, the date, the `today` chip and the dashed add button; 46rem
   is also comfortably below `md`, where D16 hands over to the agenda. Above 46rem the
   columns simply grow, so at the comp's width the layout is identical to the comp.

7. **`PlanEntryPopover` is built on the existing Base UI `Popover`**
   (`components/ui/popover.tsx`), not hand-rolled absolute positioning. See "Bugs" below —
   the hand-rolled version was the clipping bug. The primitive portals to `document.body` and
   does its own collision detection, so the `dayIndex` prop and the manual `right-0` flip are
   gone. `components/ui/popover.tsx` itself was **not** modified.

8. **The copy-week toast pluralises: "1 entry copied to …" / "N entries copied to …"**
   (`routes/plan.tsx:184`). The comp's template is unconditional
   (`copies.length + " entries copied to "`), which emits "1 entries". This is the only
   deliberate copy deviation from the comp.

9. **The panel is not coupled to the view toggle.** The comp hides the panel in Days view.
   Not copied — a panel that vanishes when you switch to Days is a panel you cannot use from
   Days. `setView` does not touch `panel`; `?panel=1` is independent, and `setPanel` uses
   `replace: true` (D15 wants it in the URL, but it is not worth a history entry).

10. **Two files beyond the §11 file plan**, plus two more:
    - `services/web/src/lib/plan/labels.ts` — the comp derives ~6 copy strings from a date
      and the route, both views, the card and the popover all need them. Locale-free and
      UTC-based rather than `toLocaleDateString`, because a locale-aware format hydrates
      differently from the SSR bytes and a local-time reading can slip a day. English-only
      today; this is the one file that changes when it isn't.
    - `services/web/src/components/plan/optimistic.ts` — **not** `lib/plan/optimistic.ts`.
      It operates on `PlanWeek`, which is declared in `server/meal-plan.ts`, and `lib/` must
      not import `server/`. Every patch re-densifies `position` and recomputes
      `recipeEntryCount` / `emptySlotCount` / `cookedCount`, so the panel's numbers can never
      disagree with the grid mid-flight.
    - `services/web/src/components/plan/PlanActions.tsx` — a context, not props: grid → cell
      → card → popover is four levels and every level would otherwise forward callbacks it
      does not use. Deliberately **no `busy` flag**: writes are optimistic and
      last-write-wins (D10), so a pending request is not a reason to disable the planner.
    - `services/web/vitest.config.ts` — see §11 note below.

11. **Additive refactor to make the write paths testable.** Every write server fn was a
    `createServerFn` handler with the logic inline, so the only way to test it was to fake a
    session. Each handler is now a thin wrapper (session + `assertMember`) delegating to a
    plain exported `(db, did, householdId, input)` function holding the behaviour verbatim:
    `addRecipesToPlan`, `addNoteToPlan`, `updatePlanNote`, `movePlanEntry`, `removePlanEntry`,
    `setPlanEntryCooked`, `copyPlanWeek`. Same pattern the pre-existing `readMealPlanWeek` /
    `readPlannedUsage` already used and the `.ics` route already consumed.
    `preferences.ts` gained `writeHouseholdPreferences(householdId, prefs)` the same way.
    **The wrappers remain the only place `active_household_id` is read**, so the household
    still cannot come from a client argument. No behaviour changed. `getCookedCandidates` was
    left un-extracted (not in §13's list).

12. **New `vitest.config.ts` with a unit/db project split and a `test:db` script.** The repo
    had no integration harness. Deliberately a separate file from `vite.config.ts`: the app
    config carries the Start/React/Tailwind plugins, none of which a test needs, and editing
    it restarts a running dev server. `#/*` subpath imports resolve without those plugins.
    The DB suites skip (never fail) when there is no reachable migrated database, so
    `pnpm test` stays green on a fresh clone. The skip probe hits the **table**
    (`select 1 from meal_plan_entry limit 0`, 5s race), not just the connection, so an
    un-migrated DB skips instead of failing 61 tests with "relation does not exist". The skip
    reason is written with `process.stderr.write`, not `console.warn` — vitest drops console
    output emitted during module load.

13. **The `.ics` event is richer than §9.3 describes — made on the user's explicit
    instruction, after the rest of the planner was already green.** §9.3 specifies a
    30-minute event whose `DESCRIPTION` is "recipe URL + any notes in that slot". Three
    changes to that, plus one confirmation:

    - **Duration is the recipe's total time**, not the fixed `SLOT_DURATION_MINUTES`. A
      90-minute braise and a 10-minute salad reading as identical 30-minute blocks was the
      complaint; the number is already on `PlanRecipeEntry.totalMinutes` (the UI renders the
      `totalTimeDisplay` string beside it), so the calendar takes the number and never the
      prose. `SLOT_DURATION_MINUTES` survives as the **fallback** for an entry with no time —
      notes never have one, and plenty of scraped recipes do not either.

    - **`totalMinutes` is clamped to 15–480 minutes.** `total_time_seconds` is scraped or
      synced, so it is not ours to trust. Below the floor a "2-minute" recipe imports as a
      sliver most calendar UIs render unreadably; above the ceiling a 3-day ferment paints
      over the rest of the week. Both bounds are wide enough that a real recipe's time
      survives untouched.

    - **Which time wins when a slot holds several recipes: none of them, because the question
      does not arise.** §9.3 already emits one `VEVENT` **per recipe entry**, and that was
      kept, so two dishes for one dinner become two events that share a `DTSTART` and each run
      their own length. That is also the honest answer to the overlap objection — a household
      cooking two dishes side by side spends the longer of the two, not the sum — and two
      concurrent events say so without the calendar having to pick one number for both.
      (Both `max` and `sum` were considered and are unnecessary under the per-entry shape;
      neither appears in the code.) A slot holding only notes still collapses to one event,
      keyed off the first note's id, at the fallback duration.

    - **`DESCRIPTION` labels its links and can carry two.** The Buttery link is prefixed
      `Buttery: ` so a description holding two URLs says which is which, and a recipe whose
      `source.url` is an http(s) URL gets a second `Source: ` line after it — Buttery is not
      jealous about only ever linking to itself, and the site a recipe was scraped from is
      often where the comments, the video and the corrections live. Order is Buttery, source,
      notes.

    The source string is treated as untrusted: `httpUrl()` parses it with `new URL` and emits
    it **only** when the scheme is `http:` or `https:`, so a label-only source ("Handwritten
    in your box", "@sam.bsky.social") and a `javascript:`/`data:`/`mailto:`/`file:` value all
    produce no line at all. It emits the parsed `href`, which also strips the tabs and
    newlines a URL could otherwise smuggle into a content line, and `escapeText` still escapes
    what survives (`,` and `;` are legal path sub-delimiters and do reach the output).

    Everything else about the file is unchanged and still asserted: CRLF, 75-octet folding
    that is safe across surrogate pairs, backslash-first TEXT escaping, entry-derived stable
    `UID`s, injected `now`/`siteUrl` for determinism, no `VTIMEZONE`. `ics.test.ts` went from
    33 to 60 cases; two pre-existing assertions were **updated on purpose** (both asserted the
    unlabelled `DESCRIPTION:https://buttery.app/recipes/…`, now `DESCRIPTION:Buttery: …`), and
    one test name changed to say "the fallback 30 minutes".

Smaller calls worth recording:

- **No server-side guard was needed for §7.2.** `meal_plan_entry.recipe_id` is FK'd to
  `recipe.id`, **not** to `household_recipe`. `removeRecipeFromHousehold` only deletes the
  `household_recipe` link row, so the RESTRICT FK is never in that path. The 23503/23001 risk
  lives entirely in the cron sweep (§7.3). The warning is a UI courtesy, exactly as §7.2 says
  ("No blocking."). Recorded as a comment on the handler so a later reader does not "fix" it
  by adding a gate.
- **Failure drops the optimistic patch rather than reverting it** (§15.17). After a failed
  write only the loader knows whether the write half-happened; the `finally` always
  `router.invalidate()`s and then clears the patch.
- **Optimistic ids are `optimistic:`-prefixed** and an entry wearing one is inert — not
  draggable, popover items and cook toggle disabled — because the server would not recognise
  the id.
- **`copyMealPlanWeek` is the one non-optimistic write**: the destination is usually a week
  that is not on screen and the toast's count is the server's answer. `copied: 0` is a
  _default_-variant toast ("That week is empty — nothing to copy"), not a destructive one.
- **`role="region"`, not `role="grid"`**, on the week table: the layout needs
  `display:contents` row wrappers, which browsers drop from the a11y tree, so grid/row/cell
  roles would describe rows AT never sees. Every cell names itself instead ("Add to dinner on
  Aug 5"; each card carries an `sr-only` "Dinner, Aug 5").
- **`.ics` extras**: `X-WR-CALNAME` is the one _property_ emitted beyond §9.3, so the imported
  calendar is named rather than "Untitled". Blank notes produce no event; `DESCRIPTION` is
  omitted entirely rather than emitted empty; an unknown timezone falls back to UTC rather
  than throwing (a corrupt stored preference must not 500 a download). The event's duration
  and its labelled Buttery/source links are the deliberate §9.3 deviation recorded above
  (deviation 13).
- **Base UI moves focus into the popover on open** (its default `initialFocus`), where the
  hand-rolled version left focus on the card. Kept — the popup is `role="dialog"` and is
  portalled out of DOM order. The ring is `focus-visible` only, so a mouse-opened popover
  shows no ring.
- **The comps' `CheckboxRow` and `RadioCard` both already exist** in
  `components/ui/checkbox.tsx` and `components/ui/radio-group.tsx` with exactly the comp's
  API. Both were used as-is; nothing was composed locally. (Two implementation briefs
  asserted they were missing — the spec §10 was right and the briefs were wrong.)
  `.bt-menu-item` genuinely does not exist and was composed locally in the popover from the
  `DropdownMenuItem` class model.

---

## Bugs found during verification and fixed

Five, all re-verified after the fix.

1. **Popovers were clipped** — the blocker the user reported. `PlanEntryPopover` was a
   hand-positioned `absolute top-[calc(100%+6px)] z-[60]` box with a manual
   `dayIndex >= 4 ? right-0 : left-0` flip, sitting inside two clipping ancestors:
   `PlanWeekGrid`'s `overflow-hidden` container (there to clip cell backgrounds at the 12px
   radius) and the page's `overflow-auto` content column. An absolutely positioned descendant
   of an `overflow: hidden|auto|scroll` ancestor is clipped by it, so any popover taller or
   wider than its cell got cut. **Fix:** rebuilt on the Base UI `PopoverContent`
   (portal → positioner → popup, own collision detection); the grid's `overflow-hidden` was
   removed entirely and the four corner cells now round themselves at 10px (12px outer radius
   minus the 2px border). Re-verified across a matrix of eight cases — top-left with 3
   entries, bottom-left with the panel railed, top/bottom-right (flips to `side="top"
align="end"`), last column with the panel docked (renders _over_ it), at the grid's right
   scroll edge after `scrollLeft`, the agenda's last card at the bottom of the page, 606px,
   and dark mode. Nothing clipped anywhere.

2. **`?cook=1` deep link was dead** — `routes/household.recipes.$id.tsx`. TanStack Router
   JSON-parses search values, so the spec's own `?cook=1` (§7.5) arrived as the **number**
   `1`. The union was `z.union([z.boolean(), z.literal("1"), z.literal("true")])`, which
   rejected it, `.catch(undefined)` swallowed it, cook mode did not open, and — because the
   parsed search is what the URL is rebuilt from — the param was silently stripped from the
   address bar. `?cook=true` worked only by accident. Fixed by adding `z.literal(1)` and
   simplifying the transform to `value !== false`. Re-verified: a hard load of
   `/household/recipes/wb-180900?cook=1` now enters the apron.

3. **The document scrolled horizontally at 768px** — `PlanEntryCard.tsx`. At `md` the grid
   renders at its `min-w-[46rem]`, correctly clipped by its own scroller inside
   `<main class="overflow-hidden">`. But the card's day/slot `sr-only` span is
   `position: absolute` (Tailwind's `sr-only`), and with **no positioned ancestor inside the
   scroller** its containing block resolved to the page shell's `relative` wrapper — so it
   escaped `<main>`'s clip. Measured `documentElement.scrollWidth` 926 vs `clientWidth` 768,
   `window.scrollX` reaching 158.5, with bare background exposed past the "This week" rail.
   Fixed with `relative` on the card root. Re-verified at 606 / 768 / 1024 / 1512:
   `scrollWidth === clientWidth`, `maxScrollX === 0`, and the grid's own scroller still works.

4. **"Wednesday" broke mid-word as "Wednesda/y"** in the days agenda — `PlanDaysAgenda.tsx`.
   The comp's 104px day column is too narrow for real weekday names: "Wednesday" in Alfa Slab
   One at 18px measures 111.48px, and the app's global `overflow-wrap: anywhere` breaks it
   rather than overflowing. Widened the `sm`-and-up track to 120px (the smallest round value
   that fits); the sub-`sm` fold is untouched. Re-verified by measuring all seven `<h2>`:
   every one is a single 19.8px line.

5. **UTC was unreachable in the timezone select** — `ThisWeekPanel.tsx`.
   `Intl.supportedValuesOf("timeZone")` omits plain `"UTC"` on this platform, but `"UTC"` is
   `DEFAULT_HOUSEHOLD_PREFERENCES.timezone`, and the grouping only pinned the _current_ zone
   — so once a household left UTC it could never return through the UI. Fixed by seeding the
   set with the default zone as well. Re-verified: 418 → 419 options, UTC present under
   "Other", and the household was set back to UTC through the UI.

Also fixed, from VERIFY.md's known-issue list: **removing an entry dropped focus to
`<body>`**, because the card the popover would hand focus back to has just been optimistically
unmounted. The owning cell now carries `data-plan-slot` and its add button `data-plan-add` (in
both views), the card records its cell from a ref captured **at mount** (`card.closest(…)` at
click time resolves `null` — the card is already gone), and the restore is a `setTimeout`, not
a `requestAnimationFrame`: Base UI restores focus from a `queueMicrotask` in the
`FloatingFocusManager` cleanup, so a task is the first reliable slot after it, and a frame
callback never fires at all while the window is occluded. Verified in-page —
`["sync:DIV", "micro:BODY", "t0:BUTTON[ADD]|Add to dinner on Aug 7", …, "t1200:BUTTON[ADD]|…"]`
— focus lands on the cell's add button and survives the reconciling invalidate.

---

## Corrections owed

1. **`ON DELETE RESTRICT` raises `23001` (`restrict_violation`), not `23503`.** `23503`
   (`foreign_key_violation`) is what a `NO ACTION` FK raises. The plan document itself is
   _not_ wrong here — §3.4, §7.3 and §13 all say "the `RESTRICT` error" without naming a code
   — but **two comments in shipped code do name the wrong one**:
   `services/atproto-cron-sync/src/render.ts:330` and `:339` (committed in P0, `0e75fde`), and
   the same claim is repeated in that commit's message. Worth correcting the comments. The DB
   test accepts either code and asserts the **constraint name**
   (`meal_plan_entry_recipe_id_fkey`) as the real check, so switching the FK between RESTRICT
   and NO ACTION will not cause a false failure, but CASCADE still would.
   (Note for the record: an earlier note claimed §13 names `23503`. It does not; the string
   `23503` appears nowhere in the plan document.)

2. **The implementation briefs — not the spec — were wrong about the design system.** Spec
   §10 correctly lists `CheckboxRow` and `RadioCard` among the primitives that already exist.
   Two agent briefs asserted each was absent and instructed a local rebuild. Both exist with
   exactly the comp's API and were used as-is. Nothing to change in the plan; recorded so the
   next brief-writer reads §10 rather than re-deriving it.

3. **§7.2's implied risk does not exist.** The section is written as if removing a recipe from
   a box could hit the RESTRICT FK. It cannot — the FK is on `recipe.id`, and
   `removeRecipeFromHousehold` only deletes the `household_recipe` link row. §7.2's own
   conclusion ("No blocking") is right; only the framing suggests otherwise.

4. **`?cook=1` as written in §7.5 does not survive TanStack Router's search parsing** without
   a `z.literal(1)` branch. The spec's literal example is now supported, but any future search
   param specified as `=1` needs the same treatment.

---

## Known gaps and limits

- **No true phone run.** macOS Chrome will not resize below ~606px `innerWidth`, so every
  "phone" check ran at 606px. That is still below `md`, so D16's forced days view, the phone
  `Sheet`, and the single-column card fold were all exercised — but **nothing here should be
  read as a 390px result**, and the sub-`sm` (<640px) fold was never seen at all.
- **The `.ics` `Content-Disposition` filename was not read back.** The JS bridge refuses to
  return response headers (and refuses any absolute URL containing a query string, so the
  request URL had to be assembled with `String.fromCharCode(63)`). The header is set at
  `routes/api/plan/week[.]ics.ts:64`; only its delivery is unverified.
- **The `.ics` was never imported into a real calendar client.** §13's manual list asks for
  it. The body was fetched and read as valid `VCALENDAR`, and the builder has 33 unit tests,
  but the round trip through Apple Calendar / Google Calendar was not done.
- **On short viewports the popover caps its own height and scrolls internally.** Measured
  `rect {t: 6, b: 347}` in a 657px viewport with `scrollHeight 445` vs `clientHeight 337` and
  `overflow-y: auto`. This is the primitive doing the right thing (`max-h-(--available-height)`),
  **not clipping** — every item is reachable and the popup draws its own border. It does mean
  that on a phone the hero image pushes "Remove" below the fold. If that is unwanted, the fix
  is a shorter hero under `sm`, not a positioning change.
- **The repo has no component/DOM test harness.** Every suite is a pure unit test or a DB
  integration test. Acceptance items 18, 21 and 22 have no automated coverage; 22's more/less
  toggle and 18's no-refetch guarantee are structural (code-read) rather than observed.
- **Deadlock avoidance under genuinely crossed multi-slot moves is not covered by a test.**
  The concurrency test fires three simultaneous `movePlanEntry` calls into one slot and proves
  the `FOR UPDATE` locks serialise and leave the slot dense — but it does not prove the
  `compareSlotKeys` ordering discipline prevents ABBA. That needs a two-connection harness
  with interleaved statements inside two held transactions.
- **`FOR UPDATE` cannot serialise two inserts into an _empty_ slot** — there is nothing to
  lock. There is no unique constraint on `position`; `created_at` breaks the tie and the next
  write renumbers densely. Documented on `lockSlot`.
- **`getCookedCandidates` is the one un-extracted server fn** and has no DB test (it is not in
  §13's list).
- **The session → `active_household_id` line is not covered by a DB test**, by design: the
  tests drive the extracted bodies. Scoping itself _is_ covered — passing household A's id
  with a non-member DID reads nothing and every write refuses.
- **The shopping-list button is inert by design** (D12/§7). It is rendered, week-scoped,
  `aria-disabled`, focusable, and tooltipped "coming soon".
- **No within-slot reorder** (D14) — the drop target is a slot, the Move dialog picks day +
  slot, and everything appends to the tail. `position` is kept dense so a later reorder can
  splice into it.
- **Removing an entry from its popover** now restores focus to the slot's add button, but the
  general a11y pass over focus order was not done.
- **Not exercised at all**: print styles, offline behaviour, real touch input (HTML5 DnD has
  no touch fallback — the Move dialog is the keyboard/touch path, per §10.4).
- **Uncommitted.** See Status. The tree is complete; `git commit` is blocked on 1Password SSH
  signing, not on the work.

The verification pass left the database as it found it: all 68 `meal_plan_entry` rows it
created were hard-deleted, the three pre-existing rows kept with `cooked_at` reset to NULL, and
the `household_preference` row it created was deleted so the household is back on defaults.
The only residue is `household_recipe.added_at` for `wb-180900` (04:09:45Z → 22:10:09Z), from
removing and re-adding it through the UI; that recipe's shared note was empty, so nothing was
lost.

---

## How to run it

```bash
# unit tests — needs nothing running
pnpm test

# DB integration suites — the dev stack must be up; railway injects DATABASE_URL
pnpm test:db

# typecheck
pnpm typecheck            # or: cd services/web && ./node_modules/.bin/tsc --noEmit

# the app
pnpm dev                  # one process-compose stack (web, postgres, redis, …)
```

Then browse **http://127.0.0.1:3000/plan** — never `localhost`; the atproto loopback redirect
and the session cookie are bound to `127.0.0.1`.

Route surface:

- `/plan` — `?week=YYYY-MM-DD` (snapped to the household's week start; malformed falls back to
  the current week), `?view=week|days` (ignored below `md`), `?panel=1`.
- `/api/plan/week.ics?week=YYYY-MM-DD` — session-gated download; omit `?week=` for the current
  week.
- `/household/recipes/$id?cook=1` — opens cook mode directly; the param is consumed once.
