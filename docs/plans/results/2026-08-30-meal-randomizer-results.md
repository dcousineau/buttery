# Results: the meal randomizer ("What should I make?")

Execution log for the plan at
[`../2026-08-30-meal-randomizer.md`](../2026-08-30-meal-randomizer.md), on
branch `feat/meal-randomizer-plan`.

`/household/randomizer` ships as a top-level surface: filters over the household
box applied server-side, one uniform draw held client-side, and the drawn recipe
rendered by the box's own `DetailPane` with every action live. No migration, no
new table, one new server function.

## What landed

| Path                                             | What                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `src/components/recipes/RecipesViewProvider.tsx` | **new** — the lifted recipes shell (§6.1): scale + view context, the two global modals, the toast queue |
| `src/components/recipes/DetailPane.tsx`          | `householdId`, `showBackLink`, `onResultAction` become props; its JSX is otherwise untouched            |
| `src/components/recipes/CookModeLauncher.tsx`    | optional `onOpened`                                                                                     |
| `src/routes/household.recipes.tsx`               | rewired onto the provider; split into `RecipesLayout` + `RecipesLayoutColumns`                          |
| `src/routes/household.recipes.$id.tsx`           | passes `householdId`                                                                                    |
| `src/server/randomizer.ts`                       | **new** — `getRandomizerPool` + the exported `readRandomizerPool` (§4)                                  |
| `src/server/randomizer.db.test.ts`               | **new** — 46 tests, every §10 bullet                                                                    |
| `src/server/randomizer.authz.test.ts`            | **new** — the wrapper's own guards, which the `db` project structurally cannot reach                    |
| `src/lib/randomizer/draw.ts`                     | **new** — §5's draw / re-roll / no-repeat / staleness / filter defaults, pure                           |
| `src/lib/randomizer/escape-like.ts`              | **new** — §4.4's `%`/`_`/`\` escaping; the repo had none                                                |
| `src/lib/plan/week.ts`                           | `slotForHour` (§8)                                                                                      |
| `src/lib/api/{types,keys,queries,transport}.ts`  | the randomizer DTOs, key, query factory and transport wrapper — additive                                |
| `src/routes/household.randomizer.tsx`            | **new** — the route and page composition                                                                |
| `src/components/randomizer/*`                    | **new** — filter bar, filters sheet, empty state, box result, corpus result, plan shortcut, motion hook |
| `src/components/recipes/RecipeView.tsx`          | `recipeViewDataFromDetail` mapper, additive                                                             |
| `src/components/AppSidebar.tsx`                  | Randomizer stops being `soon`                                                                           |
| `scripts/dev/vitest-db.sh`                       | **new** — run the `db` project without a Railway login                                                  |

622 unit tests and 324 db tests pass; typecheck, oxlint and oxfmt are clean.

---

## The four things §11 asked for

### 1. Enrichment coverage in a real box

Measured against a 199-recipe box built by `db:seed:run` and enriched by the
real rules classifier (`pnpm --filter @buttery/pipeline backfill`, 243 recipes,
all `status='ok'`).

| Dimension the filters read       | Recipes covered    | Provenance                     |
| -------------------------------- | ------------------ | ------------------------------ |
| `diet`, at least one `likely`    | 140 / 199 (70%)    | **real** — `rules@1`           |
| `allergen`, any warning verdict  | 107 / 199 (54%)    | **real** — `rules@1`           |
| `allergen`, any row at all       | 155 / 199 (78%)    | **real** — `rules@1`           |
| `total_time_seconds` not null    | **97 / 199 (49%)** | **real** — the corpus itself   |
| `recipe.recipe_cuisine` not null | **0 / 243 (0%)**   | **real** — the corpus itself   |
| `meal_type`                      | 171 / 199          | _fixture, not measurable here_ |
| `cuisine` label                  | 174 / 199          | _fixture, not measurable here_ |
| `spice_level`                    | 171 / 199          | _fixture, not measurable here_ |

**The bottom three rows are not a measurement and must not be read as one.**
`meal_type`, `cuisine` and `spice_level` are written only by the `llm-enrich`
step, and `LLM_ENRICHMENT_ENABLED` is a fail-closed env gate with no key in this
environment — so their true local coverage is **zero**. Those rows come from a
hand-built dev fixture (`method = 'llm:dev-fixture'`, ~1 in 9 recipes
deliberately left unlabelled) that exists so the filter bar could be exercised
in a browser at all. They measure the fixture. The honest statement about the
pipeline is: **the three dimensions the comp puts front and centre — meal type,
cuisine, spice — have no coverage at all until the LLM half is switched on.**

Two of the real numbers change how the surface should be read:

- **`recipe_cuisine` is null on every one of the 243 seeded recipes.** §2.1's
  "author value OR derived label" is, in this corpus, _only_ the derived label.
  The OR is still right — a synced or hand-typed recipe can carry the column —
  but the cuisine filter is an enrichment filter in practice, and it inherits
  enrichment's coverage hole entirely.
- **`total_time_seconds` is present on 49% of the box.** This is the number that
  vindicates §2.3's control and then overturns its default — see "Post-review
  changes" below. Measured in the browser: with untimed recipes included,
  "≤ 30 min" narrows a 196-recipe pool to 132; with them excluded, to 32. §2.3
  put the control in the sheet defaulted **off**, on the reasoning that a
  max-time filter should mean what it says. At 49% coverage that default turns
  one chip click into an 84% collapse of the shelf with nothing on screen
  saying why — which is the failure §2.3 itself named, reached from the other
  side. It now defaults **on**.

**Does the coverage line deserve to be inline rather than in the sheet?** §11
asks this. On these numbers, no change: `unenrichedInScope` — recipes with no
`recipe_enrichment` row at all, or one that is not `ok` — is the _rare_ case
(14 of 199 in the browsing fixture, and 0 of 243 after a clean backfill,
because the rules pass gives every recipe a row). The _common_ case is a recipe
that has a row and is still missing one dimension's labels, which is
**28 of 199** here — and §4.3's line, by its own definition, does not describe
that at all. That is the real gap this feature should report on, and the events
in §9 cannot separate it either. Recorded rather than fixed: changing what
`unenrichedInScope` counts is a spec change, not an implementation choice.

### 2. Does "skip recent" at 14 days empty real pools?

No, and not close. In the browsing fixture the default filter set hides **2 of
199** recipes, and the pool line reads "Rolling from 197 recipes · skipping 2
from the last 14 days". That box is unusually large for a household, but the
ratio is what matters: a household would need to have planned a double-digit
fraction of its box inside two weeks for 14 days to bite. The default stands.

The one caveat found while testing: the §4.6 predicate is **one-sided**
(`plan_date >= today - N`), so it also hides anything already planned for a
_coming_ day — planning Friday's dinner on Monday removes it from Monday's draw.
That is arguably the right behaviour ("you've already decided about that one"),
but it is not what the control's label says, and the spec does not mention it.
Pinned with a test so it cannot change silently; flagged here for a copy or
scope decision later.

### 3. Did the §6.1 refactor stay plumbing-only?

**Yes for `DetailPane`'s JSX; no for its props, by design.** The pane's markup
is unchanged apart from wrapping the mobile back link in `{showBackLink && …}`.
It gained three optional-or-derived props — `householdId` (required, replacing
`useRouteContext({ from: "/household/recipes" })`), `showBackLink` and
`onResultAction` — each of which §7.2 sanctions and each justified below.

**The safety net the spec assumed does not exist.** §10 says "the recipes box's
existing tests pass unchanged … that suite is the whole safety net for the
prerequisite step". There is no such suite: `src/routes/` contains zero test
files, no test renders `DetailPane`, `RecipeLedger` or the recipes layout, and
`@testing-library/react` is a devDependency with no `render()` call site
anywhere in the repo. So the refactor shipped with **no test could have needed
editing, because none exist** — which is not the same thing as the refactor
being proven safe.

What was used instead: `tsc` (which does catch a missing `householdId` at every
call site), and a browser walk of `/household/recipes` — the ledger renders 197
recipes, a recipe opens in the detail pane with every action present, favourite
writes, and the ledger's "Add" button opens the chooser through the lifted
provider's `openAddChooser`. That is weaker than a suite and is recorded as
such.

`RecipesLayout` had to split into an outer half that mounts the provider and a
`RecipesLayoutColumns` half that consumes it, because the ledger's "Add" button
opens the shell's chooser and therefore has to be a descendant of the context.
No behaviour changed.

### 4. Did §7.2's trigger fire?

**Yes — and the extraction was declined. That is the honest answer.**

§7 asks for the pool's lightweight card (title, image, source, time) to fill the
gap while the detail query lands. It was built, and it was a verbatim copy of
`DetailPane`'s page container, its `display-title` heading, its meta-row class
string and its 4:3 image box — which is precisely what §7.2 forbids outright.
The review pass caught it and deleted it.

§7.2's own remedy is the extraction: pull `RecipeDetailHeader` out of
`DetailPane`, rewrite `DetailPane` to compose it, get the box's tests green
first. The third of those steps is impossible — see Q3, there are no tests — and
the payoff is that a title appears roughly one animation frame earlier on a slow
link. So the placeholder is a `Spinner`, matching what the corpus half already
shows, and the class of bug survives: nothing stops the next person copying that
markup back in. The cost is stated in the component's own doc comment, and the
right fix if the cost is judged too high is the extraction, not a second copy.

**Nothing else was rebuilt.** `DetailPane` renders whole for every box result,
in its own arrangement, and the comp's bespoke result header, tag chips, action
row and body skeleton were never built (§7.1 says to ignore them and the comp's
own annotation agrees). The controls region duplicates none of the pane's
actions; the only randomizer-owned action is §8's shortcut.

**Props added, each justified as §7.2 requires:**

| Prop                                       | Why                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `DetailPane.householdId` (required)        | `useRouteContext({ from: "/household/recipes" })` pins the pane to one route id; a second route cannot be expressed as a `from` literal     |
| `DetailPane.showBackLink` (default `true`) | the mobile "Back to the shelf" link navigates _away_ from the randomizer, whose controls sit directly above the result                      |
| `DetailPane.onResultAction` (optional)     | §9's `randomizer_result_action`; three of its five values are gestures inside this pane and no event it already sends can stand in for them |
| `CookModeLauncher.onOpened` (optional)     | the fourth of those, one level down; fires beside the launcher's own `cook_mode_opened` rather than replacing it                            |

---

## Defects found and fixed during review

Two Opus review agents went over the Sonnet build adversarially. The server
reviewer's method was not reading assertions and judging them by eye — it broke
the shipped code 21 ways and watched which tests noticed.

**The corpus read had no authorization.** `readRandomizerPool`'s
`source: "corpus"` branch started from `recipe` with no membership join and
never touched its `did` argument, while still using `householdId` twice against
private data: the box anti-join and `skippedRecent` over `meal_plan_entry`. A
caller passing another household's id got a full pool back and learned, by
omission from the anti-join, which public recipes that household had kept.
`getRandomizerPool`'s `assertMember` covered the only caller, but §3 makes the
membership join a property of the read. Gated, and pinned.

**Five test properties were vacuous.** Each of these mutations to shipped code
left the original 37-test suite fully green: dropping the allergen facet's
verdict filter; making the meal-type facet alphabetical instead of canonical;
dropping `household_id` from the corpus anti-join (which would hide from every
household every recipe any _other_ household had kept); letting the diet
predicate accept any verdict rather than only `likely`; and the `dairy_free`
facet exclusion, tested against a fixture containing no `dairy_free` row. All
five mutants now die. The two predicates most likely to have been faked — the
`%`/`_` escaping and the timezone boundary — held up under mutation.

**A layout bug that was not what it looked like.** The page grew 204px past the
viewport, the sticky controls scrolled away and the ingredient column was cut
mid-list. The cause was not the flex containment (which was correct): `main` is
`overflow-hidden` but not positioned, so `RecipeTagStrip`'s absolutely
positioned `.sr-only` spans resolved against a containing block _outside_ it and
escaped the clip. One `relative`. Verified at 1280×720, 1024×768 and 390×844,
and re-verified after the final pass: document height equals viewport height,
`window.scrollY` pinned at 0, the result region scrolling internally.

**Widening into an empty corpus pool cleared the drawn recipe** off screen —
exactly what §5.6 forbids. **The dropdowns stayed open** over the result after a
selection and their inert backdrop swallowed the next click. **A set chip
painted the same red as the roll CTA**, and a set single-select chip had no set
treatment at all. Sheet headings were uppercase against the brand's sentence
case. Menu chips announced only their value ("Dinner"); the stale marker was
announced to nobody. A corpus draw rendered a raw `PT0S`. The coverage line
called public recipes "yours" after widening. The skip-recent window was spelt
two ways on one screen, with `14` hardcoded in three places.

**A Postgres typing trap, worth stating because the spec's own SQL sketch has
it:** `plan_date >= $today::date - $skipRecentDays` fails with
`operator does not exist: date >= integer`. With an untyped bound parameter the
planner resolves `date - date -> integer` in preference to
`date - integer -> date`. The cast has to be explicit (`${skipRecentDays}::int`).

**The corpus cap was an alphabetical prefix.** `order by r.name limit 201` makes
every recipe sorting past the 200th permanently undrawable — a randomizer that
quietly stops suggesting anything after roughly the letter B. §4.5 asks only
that the cap be surfaced, and it was; a surfaced cap over a biased sample is
still a biased answer. Now `order by random()`, so the capped pool is a uniform
sample of what matched. Re-rolling never refetches (§5.2), so a session still
sees one stable pool.

---

## Post-review changes

Five changes the user asked for after the first pass landed. Each is recorded
here because three of them contradict the frozen spec, and the spec says to
capture reality rather than edit it.

**`includeUntimed` now defaults to `true`** — §2.3 said `false`. The reasoning
is the 49% measurement above: the old default made touching the time chip
collapse a 196-recipe pool to 32, silently. Flipping it makes the destructive
act the deliberate one, which also retires the concern §2.3 raised about
untimed recipes disappearing with nothing on screen to say so. Defaulted in
both halves — `defaultFilters()` and the server's `normalizeFilters` — with the
reasoning at both code sites, because a reader checking the spec will otherwise
"correct" it back.

**"Include untimed recipes" moved out of the sheet and into the "Any time"
dropdown**, below a separator. It is a time control, so it now lives with the
control it modifies rather than three sections away in "More filters". It is
therefore no longer a sheet control, and `countSheetFilters` — which drives the
"More filters · N" badge — stopped counting it.

**Time options dropped "Under" for `≤`.** `Under 30 min` → `≤ 30 min`, on the
options and on the chip. A real U+2264, per the brand's "real typographic
characters" rule.

**The collection filter became a multi-select checkbox list.** It was a native
`Select` — one collection or none. It is now a `CheckboxRow` list styled
identically to Diets and Avoid… in the same sheet, and `collectionId?: string`
became `collectionIds?: string[]`, ORed server-side: a recipe qualifies if it
sits in **any** ticked collection. That is what a checkbox list means when two
boxes are ticked, and rendering a single-select as checkboxes would have been
the worse half of the two readings. The `rce.household_id` guard on the
predicate is unchanged and still load-bearing. Verified in a browser against
two seeded collections of 28 and 22 disjoint recipes: one ticked gives 27
(one hidden by skip-recent), both give 49.

**Filters persist in `localStorage`, per household.** They reset to defaults on
every visit before this. The pure serialize/parse/merge half is
`lib/randomizer/persist.ts` (19 tests); the hook half owns the two storage
calls, both in try/catch — Safari private mode and "block site data" throw on
_access_, not only on write. The blob is version-tagged and every field is
type-validated individually, so a corrupt, truncated or older-shape value falls
back to defaults rather than throwing, and a field added in a later release
comes back as its own default rather than `undefined`.

**`source` is deliberately not persisted.** Widening to the public corpus is
explicit and opt-in (§4.5); restoring someone into corpus mode on their next
visit would make it implicit. Every visit starts in the box. It is never
written to the blob at all, rather than written and ignored on read — verified
by reading the stored value in the browser after widening.

The one thing SSR forces: the route server-renders, so filters cannot be read
from storage during the first render without a hydration mismatch. State starts
at `defaultFilters()` (matching what the loader primed) and the stored set is
applied once hydration completes, costing one refetch on mount that
`keepPreviousData` covers. Verified: no flash, no double fetch, no hydration
warning.

---

## Decisions and deviations

**`$if` does not exist in this repo.** §4.4 sketches the query with Kysely's
`.$if`; nothing in `services/web/src` has ever used it. The idiom here is a
reassigned `let query`, which is what shipped.

**Predicates are raw `sql<boolean>` fragments, not the typed `eb(...)`
builder.** The box join and the bare corpus scan have different Kysely
table-alias sets, and widening `TB` to share one `eb`-based predicate breaks
operand inference on every value comparison (7 `TS2345` errors, verified). A raw
fragment carries no `TB`, so one set of predicates serves both scopes — the
reuse `$if` would have bought. Every value is still a bound parameter; this is a
typing choice, not a safety one. `collectionId` is a correlated `EXISTS` rather
than a conditional `innerJoin` for the same reason.

**Facet labels come from one bounded `recipe_vocab` join per dimension.** There
is no other runtime query against that table in the repo — `lib/recipe-vocab.ts`
mirrors it client-side, but only for `cuisine`/`category`/`cooking_method`/
`diet`, not `meal_type` or `spice_level`. `server/recipe-enrichment.ts`'s module
doc anticipates exactly this and names the bounded join as the sanctioned
alternative. The join is scoped to the slugs the facet aggregates already found
present, never wider.

**A corpus draw renders `RecipeView`, not `routes/recipes.$id.tsx`'s
`RecipeDetail`.** §4.5 says "render the public recipe view (`recipes.$id.tsx`'s
shape)", but that route's `RecipeDetail` is a route-local, non-exported function
carrying `page-wrap`, a "Back to the pantry" link and JSON-LD — page chrome that
is wrong inside a result region. `RecipeView` is the exported presentational
reader the create-form preview already uses, at the same `max-w-[54rem]` measure
and the same title size as `DetailPane`, and its own doc says interactive chrome
belongs to callers. That needed a `RecipeDetailData → RecipeViewData` mapper,
added beside it; a data mapper is not markup, so §7.2's copy ban does not bite.

**"Clear filters" does not un-widen.** §5.5 says "resets every filter to its
default", and §4.1 groups `source` under `// scope`, separate from the filter
fields. Widening is its own affordance with its own dismiss chip, so clearing
filters leaves you where you are rather than silently walking you back to your
box mid-browse. The comp resets `source` on clear; this is a deliberate
departure.

**Filter state is component state, not the URL.** Nothing in the spec asks for a
bookmarkable filter set, `clearFilters` restores non-empty defaults rather than
an empty query string, and the comp keeps it local. A reload starts at the
defaults.

**One spelling of the skip-recent window.** The pool line said "the last 2
weeks" (the spec's verbatim string) while the chip said "the last 14 days" (the
comp's), with `14` hardcoded in three places. One constant, `SKIP_RECENT_DAYS`
in `draw.ts`; both now read "14 days". The spec's wording lost, because two
spellings of one number on one screen is worse than either wording.

**`slotForHour` is total.** Finite input wraps into 0–23; non-finite returns
`snack` — a deliberately neutral, non-mealtime slot for "we don't know the
hour", rather than confidently guessing breakfast or dinner. Cut points are the
comp's verbatim: breakfast 0–9, lunch 10–14, dinner 15–20, snack 21–23, with a
test on both sides of every boundary.

**`open_recipe` is the one §9 value that never fires.** On this surface the
drawn recipe _is_ the full recipe view, so there is no gesture to record, and
§7.2 forbids adding an action the design does not have just to make an event
fire.

**Was known and not fixed; fixed in a follow-up.** `DetailPane`'s own
`meal_plan_entry_added` and `grocery_items_added` captures hardcoded
`source: "recipe_detail"`, so a randomizer-driven grocery add was mis-attributed
to the recipe page. The follow-up threaded the surface in as `analyticsSurface`,
defaulted to `"recipe_detail"` so `/household/recipes/$id` emits byte-for-byte
what it did before, with `RandomizerBoxResult` passing `"randomizer"`.

The same pass found two more of the shape. `CookModeLauncher`'s button path
hardcoded `source: "button"` across all three surfaces it mounts on, so the
public recipe page's apron was indistinguishable from the household page's; it
takes an `analyticsSource` now (`"public_recipe"` from `/recipes/$id`), named
for the value rather than the surface because that event's vocabulary is already
caller-supplied and already mixes surface names in — `/household/plan` sends the
same event with `source: "plan_card"`. Left literal on purpose:
`source: "deep_link"`, which names how the reader arrived rather than where they
were, and `recipe_published`'s `from: "detail_lock"`, same shape but a different
field and a different event's problem.

`onResultAction` is unchanged and stays: it reports a gesture under the caller's
event name (§9's `randomizer_result_action`), which is a separate question from
which surface the pane's own events claim to come from.

None of it was verified in a browser, and cannot be: PostHog is production-only
(`lib/analytics.ts` hands back a no-op stand-in everywhere else), so no dev
browser can watch these captures fire. Read against all four call sites instead,
with `typecheck` and `test` clean.

---

## What was verified in a browser, and what was not

**Verified**, against a signed-in `chef.test` household with 199 boxed recipes,
46 public recipes outside the box, 12 favourites and 7 live plan entries: the
intro state; a drawn box result with every `DetailPane` action present; the
grocery preview opening from the drawn recipe and committing 10 items; the §8
shortcut writing today's breakfast in the household's timezone and toasting
"Added to Monday breakfast"; filtering (196 → 19 by meal type, 196 → 1 by
ingredient); the "More filters" sheet; an empty pool showing "14 of your 198
recipes are still being tagged"; widening rolling immediately; a corpus result
with one action and no favourite; keeping it flipping the same card to the box
renderer with no re-roll; the stale marker surviving a filter change; "That's
the only match" and its recovery after clearing filters; the ~700ms tumble under
normal motion versus an immediate commit under `prefers-reduced-motion`; scroll
containment at three widths; and `/household/recipes` still working after the
§6.1 refactor.

**Not verified.** Any of this against a box built by the atproto sweep rather
than `db:seed:run` — which is the measurement that would settle whether the
coverage numbers above are a seed artefact or the real shape of the network. No
multi-user or concurrent testing. No real LLM enrichment, so the meal-type,
cuisine and spice filters have only ever been exercised against a hand-built
fixture. No mobile device, only a resized viewport.
