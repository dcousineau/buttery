# Results: Recipe enrichment pipeline

Execution log for the plan at [`../2026-08-20-recipe-enrichment.md`](../2026-08-20-recipe-enrichment.md).
Built on branch `claude/recipe-enrichment`, which targets `claude/data-pipelines-bullmq-crtvmc`
rather than `main` — the BullMQ kernel this builds on is not merged yet (plan §14).

Records what was actually built, how it was verified, the deliberate deviations, and the
measured coverage numbers the plan asked for.

## Orchestration

One coordinator and nine build agents over disjoint file sets in a single working tree. No
worktrees: the plan's sections partition cleanly by file, so parallel agents could not collide
and a merge per agent would have bought nothing.

| Agent           | Plan section | Files                                                                                                              |
| --------------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| food-extract    | §4           | `packages/food/**`, every `#/lib/grocery/*` import site, `scripts/**`                                              |
| food-traits     | §4.1         | `scripts/build-food-lexicon.ts`, `scripts/food-allergens.ts`, `scripts/food-tags.ts`, `packages/food/src/traits.*` |
| contract        | §5           | `packages/pipeline-contract/**`                                                                                    |
| migration       | §3           | the one generated migration file                                                                                   |
| kernel          | §6           | `services/pipeline/src/workflows/{define,hosts}.ts`, `worker.ts`                                                   |
| workflow        | §7           | `services/pipeline/src/workflows/recipe-enrichment/{index,steps}.ts`, `lib/**`                                     |
| classifiers     | §8           | `.../recipe-enrichment/classify.ts`, `.../classifiers/**`                                                          |
| triggers (web)  | §9           | `services/web/src/server/{enrichment-queue,recipes-write,recipe-import}.ts`                                        |
| triggers (sync) | §9           | `services/pipeline/src/workflows/atproto-sync/{steps.ts,lib/render.ts,lib/sweep.ts}`                               |
| read surface    | §10          | `services/web/src/server/recipe-enrichment.ts`, the panel, the detail route                                        |

`services/pipeline/src/workflows/recipe-enrichment/types.ts` was written by the coordinator
rather than by either workflow agent. It is the contract the workflow and the classifiers both
build against, and handing them a fixed interface is what let them run at the same time instead
of one waiting on the other.

## What was built

Everything in §1.1, plus one addition and one subtraction, both noted under **Deviations**.

- **§3** `recipe_enrichment` + `recipe_enrichment_label`, a new `allergen` vocab dimension with
  ten slugs, and `pescatarian` + `dairy_free` added to `diet`. Migration applied, rolled back,
  re-applied and codegen'd; `up → down → up` is clean.
- **§4** `services/web/src/lib/grocery/` is now `@buttery/food`. `merge.ts` stayed in web.
- **§4.1** `packages/food/src/traits.json`, generated beside `lexicon.json` from the same pinned
  taxonomy revision.
- **§5** `@buttery/pipeline-contract`.
- **§6** `ctx.enqueue`, on `StepContext`, on `WorkflowHost`, in `jobHost` and `consoleHost`.
- **§7** the `recipe-enrichment` workflow: `enrich`, `backfill`, `backfill-report`.
- **§8** `classifiers/allergen.ts` and `classifiers/diet.ts` behind an ordered `Classifier[]`.
- **§9** both write paths mark stale in their own transaction and enqueue after it commits.
- **§10** `getRecipeEnrichment` plus a dev-gated panel on the recipe detail route.
- **§11** `RECIPE_ENRICHMENT_MAX_IN_FLIGHT` in `.env.example` and `.railway/railway.ts`, the
  three shared packages added to the watch patterns, and AGENTS.md + the pipeline README updated.

## Measured coverage

Both numbers the plan asked for, plus the trait coverage that bounds what the rules can claim.

### Food traits, over the pinned Open Food Facts taxonomy

`lexicon.json` holds 4356 foods. After inheritance:

| trait                 | foods | share |
| --------------------- | ----: | ----: |
| `vg` (vegan)          |  4169 | 95.7% |
| `vt` (vegetarian)     |  4169 | 95.7% |
| at least one allergen |  1102 | 25.3% |
| at least one tag      |   715 | 16.4% |
| any trait at all      |  4219 | 96.8% |

The taxonomy itself carries only 221 `vegan:en:` lines, 224 `vegetarian:en:` and 74
`allergens:en:`. Those few hundred declarations reach 4169 foods because the fold walks the
hierarchy — `en:meat` alone carries `vegan: no` + `vegetarian: no` and sweeps everything beneath
it. That amplification is the whole reason §4.1 exists rather than a curated list.

Allergen and tag coverage is lower and is bounded by the reach of the curated seed maps, not by
the taxonomy. That is the number that says how much the classifiers can actually claim.

### Recipes classified, and the lexicon's miss rate

Against the repo's dev seed corpus (33 recipes, plus 2 hand-written verification recipes):

- **35 / 35 recipes came back `ok`.** No `error` rows, no `gone`.
- **396 ingredient lines, 0 unresolved — a 0.0% miss rate.** One group header was excluded.
- 383 of those 396 lines (96.7%) resolved to a food that also carries traits.

Label verdicts across the corpus: `allergen` 71 `contains`, 279 `not_detected`, and **zero**
`may_contain` and zero `unknown`; `diet` 120 `excluded`, 65 `likely`, 270 `unknown`.

**That 0% is not the number the plan wanted, and it should not be read as one.** The plan asked
for the unresolved share because it decides whether phase 2 is worth it — but this corpus is the
repo's own dev seed, which exists to calibrate this very matcher, so it is not an independent
sample of what the network writes. The repo's own `calibrate.db.test.ts` agrees independently
(338/338 distinct lines, 100%, against a 90% target), which rules out a measurement bug but not
the sampling problem. Recorded as an open conjecture (`d-c75ed1da`); the test that settles it is
the same measurement over recipes rendered by a sweep of the live network, which nobody curated
against this lexicon.

The practical consequence today: **the `may_contain` and `unknown` allergen paths get no
exercise from real data.** They are covered by unit fixtures only. A corpus with real misses in
it is what will show whether their thresholds are right.

## Verification

### Automated

| Check                                          | Result                                             |
| ---------------------------------------------- | -------------------------------------------------- |
| `pnpm -r test`                                 | 818 passed, 266 skipped (the skips are DB suites)  |
| `pnpm --filter @buttery/pipeline test`         | 98 passed, 9 files                                 |
| `pnpm --filter @buttery/food test`             | 85 passed, 4 files                                 |
| `pnpm --filter @buttery/web test`              | 511 passed                                         |
| `pnpm --filter @buttery/pipeline test:db`      | 18 passed — enrich transaction, cascade, claim SQL |
| web DB suites (`vitest run --project db`)      | 259 passed                                         |
| `pnpm -r typecheck`                            | clean                                              |
| `pnpm lint`                                    | clean (3 pre-existing React warnings, no errors)   |
| `pnpm format:check`                            | clean                                              |
| `db:migrate:up` → `down` → `up` → `db:codegen` | clean; both tables present in `src/db/types.ts`    |

The DB suites cover what §12.2 named: the `enrich` write transaction, the cascade delete
(asserting deleting a `recipe` takes its enrichment with it and does **not** raise `23001`), and
the backfill claim query's ordering.

### End to end, against the local stack

Stack up via `process-compose`, browser driven with Playwright, `127.0.0.1` throughout.

1. **The registry.** `GET /workflows` reports `recipe-enrichment` with its three steps and
   `maxInFlight: 16`; the worker logs `queues: ["atproto-sync","demo","recipe-enrichment"]`.
2. **The tricky recipe (§12.4).** A "Vegetarian Pad Thai" with fish sauce in it comes back
   exactly as the plan demanded — `diet/vegetarian = excluded` citing _3 tablespoons fish sauce_
   as its evidence line, and `allergen/fish = contains`. Soy sauce independently produced
   `soy`, `wheat` **and** `gluten`; eggs and crushed peanuts produced theirs; `pescatarian` came
   back `likely`, which is the right answer for a dish whose only animal products are fish and
   egg.
3. **The eager write trigger (§12.3).** Signed in as `chef.test`, saved a "Ghee and Gelatin
   Panna Cotta" through the app's own form. The save enqueued, the worker classified, and the
   row was `ok` seconds later: `allergen/milk = contains` citing both the cream and the ghee,
   `diet/vegetarian = excluded` citing the gelatin, and `diet/kosher = excluded` under
   `meat-and-dairy-cooccurrence` citing all three. Nobody typed a label.
4. **Backfill (§12.5).** `POST /jobs/recipe-enrichment {"name":"backfill","data":{"limit":50}}`
   claimed 33, fanned them out, and the report folded them: `succeeded: 33, failed: 0, ok: 33,
remaining: 0`. A second POST claimed 0 — the fingerprint short-circuit holding.
5. **The dev panel (§12.3).** A `<details>` pinned bottom-right, collapsed to
   "ENRICHMENT · DEV ONLY · OK · V1" and expanding to status, classifier version, and every
   label's verdict, confidence, method and evidence lines — each `not_detected` carrying its own
   "≠ free of" caption. Its first attempt was illegible (see the defects below); this is the
   fixed one, confirmed by viewport screenshot in both states.
6. **The sync trigger and `ctx.enqueue` (§12.6).** Published that same recipe to the local
   atproto dev-env PDS, deleted its local row, pointed `services/pipeline/.env` at the dev-env
   and posted a sweep. `enumerate` found the repo through the PDS list, `renderRecipe` rendered
   the record as a fresh `origin='sync'` row and marked it stale, `sync-repo` handed it to the
   **other workflow's queue** through `ctx.enqueue`, and the worker drained it: `status='ok'`,
   23 labels, `allergen/milk = contains` and `diet/vegetarian = excluded` with the same evidence
   lines as before. The whole cross-workflow handoff, end to end, against a real queue.
7. **The cascade (D11), live.** Deleting that `recipe` row took its enrichment row and all 16 of
   its labels with it, and raised no `23001` — the same thing the db test asserts, observed on a
   real row with real children.

## Deviations from the plan

| #   | What                                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **`traits.json` carries a fourth key, `tg`.** §4.1 sketches `{vg, vt, al}`, but §8.2 asks for halal/kosher pork and alcohol exclusion and for pescatarian to tell meat from fish, and those three keys answer none of it. A curated `scripts/food-tags.ts` ancestor map adds `meat`, `pork`, `alcohol`, `seafood`, folded exactly the way allergens are.              |
| 2   | **`SOURCE_COMMIT` was not bumped.** §4.1 says to. Re-pinning to a newer upstream taxonomy would churn `lexicon.json` and risk the orphan check failing on renamed nodes, and nothing here needs a taxonomy update. Keeping the pin is what proves both generated files derive from the same revision. `lexicon.json`'s bytes are unchanged.                           |
| 3   | **`RECIPE_ENRICHMENT_MAX_IN_FLIGHT` is set on the Railway `pipeline` service only**, not on `pipeline-worker` as §11 says. `globalConcurrency()` is read only by `reconcile.ts` and `server.ts`, both server-process code, and `ATPROTO_SYNC_MAX_IN_FLIGHT` already follows that rule. A variable on the worker that nothing reads reads as configuration and is not. |
| 4   | **`recipe_vocab.source = 'buttery'`** for the new rows — a third value beside `seed` and `discovered`. §3.4 said only to match "however the existing seed distinguishes them", and neither existing value fits a row that is migration-shipped but has no upstream token behind it (D12).                                                                             |
| 5   | **`paleo` emits `unknown`.** §8.2 enumerates rules for every other diet slug and says nothing about paleo. Inventing one was not the job, so it returns `unknown` with `rule: "not-specified-in-plan"`.                                                                                                                                                               |
| 6   | **A workflow-level `defaultJobOptions`,** which the plan does not mention. See the gap below — without it the `backfill` job §7.2 tells an operator to POST is retained in Redis forever.                                                                                                                                                                             |
| 7   | **`renderRecipe` returns `string \| null`** (the advanced recipe id) rather than `void`, and the ids ride a `SweepResult` local to `sweep.ts` rather than being added to `RepoOutcome` — that type is a job return value `finalize` folds over Redis, and `finalize` has no use for the ids. `plan.ts` and its test needed no changes.                                |

## Gaps and defects found

Recorded in the decision journal; none is fixed here except where noted.

- **`POST /jobs/:queue` drops the target step's job options** (`def-9d7f5678bca6`).
  `server.ts:135` calls `queue.add(name, data)` with no third argument, so a job posted by hand
  or from the board gets no `attempts`, no backoff and no retention from its step —
  `jobOptionsFor` exists and is used by `flowJobFor` but not here. This is pre-existing, on the
  BullMQ branch, and is **not fixed** in this PR. `recipe-enrichment` insures itself against it
  with a queue-level `defaultJobOptions`; `atproto-sync` currently does not.
- **The enqueue fired before commit on the import path** (`def-44ec8bddf10d`) — found in review,
  **fixed**. `persistRecipeDraft` takes `db` as a parameter so a caller can hand in its own open
  transaction, and `commitImport` does. Enqueueing straight after `insertLocalRecipe` therefore
  raced the chunk commit on the app's highest-volume write path: the job read a recipe that was
  not there yet, completed as `gone`, and the row stayed `stale` until a manual backfill. The
  enqueue now happens only when `persistRecipeDraft` owns the transaction, and `recipe-import.ts`
  enqueues from the same post-commit pass that already fetches hero images. Pinned by a db test
  that re-selects each enqueued id on a separate pooled connection; reverting the guard makes it
  fail, which is the only way to know a regression test is load-bearing.
- **`@buttery/food` was unusable from the pipeline** (`def-f2c61f21883d`) — **fixed**. The moved
  modules kept `services/web`'s bundler-style extensionless relative imports, which Node's native
  ESM resolver rejects, so both pipeline processes died at import with `ERR_MODULE_NOT_FOUND`.
  Nothing in the gate caught it: `tsc` resolves extensionless specifiers and so does vitest. Only
  booting the stack surfaced it. All relative imports in the package now carry `.ts`.
- **The dev panel rendered illegibly** (`def-7ab09f64c703`) — found by looking at it, **fixed**.
  Its `Card` carried `bg-muted/20`, so the page showed through, and its wrapper sat at
  `z-(--z-banner)` (40), below the header's `--z-sticky` and below the detail pane's own
  stacking — the recipe's Instructions heading, step badges and Notes heading painted straight
  over it. It is now an opaque native `<details>` at `--z-popover`, collapsed by default with the
  status on its summary. Worth noting how it was found: every automated check passed on the
  broken version. Nothing but a screenshot was going to catch it.
- **`likely vegetarian` on an unresolved animal line** (`def-d4cd694d9d86`) — **fixed**.
  `allergen.ts` had an unresolved-line text-pattern pass and `diet.ts` did not, so a recipe whose
  one unresolved line was "nam pla" or "lardons" could come back `diet/vegetarian = likely` when
  it fell under the coverage threshold. That is the single wrong answer in this feature a person
  could act on and be harmed by. A strong unresolved animal-derived match now excludes; a weak or
  carrier one forces `unknown`; none of them can produce `likely`.
- **§8.1's "the matched food's trait is `maybe`" branch has no data behind it**
  (`def-84a8ab093dbb`) — **not fixed, and not fixable here.** Open Food Facts' `allergens:en:` is
  a flat token list with no tri-state, unlike `vegan:en:`/`vegetarian:en:` which do carry
  `maybe`. The other two `may_contain` triggers are implemented in full. Making this one real
  means a source that grades allergen confidence per food, which the taxonomy is not.
- **Generated JSON is checked in as the pre-commit hook's output, not the generator's**
  (`d-7ec445f7`, resolved `d-6fa69e89`). Regenerating `lexicon.json` produced a 10,718-line diff
  whose data was byte-identical; `lint-staged` runs `oxfmt` over `*.json`, which pretty-prints
  what the script emits compact. Running `oxfmt` on the regenerated file reproduces the
  checked-in blob exactly. Worth knowing before anyone panics at that diff again.

## Not built, deliberately

Everything in §1.2 stayed out: no nutrition estimation (the columns land, all null), no LLM
call, no Randomizer UI or query, no user-facing label display outside the dev panel, no user
correction UI, nothing new published to atproto, and no automatic reprocessing on a
`classifier_version` bump.

## Open items for a human

- **`railway config plan` and `railway config apply` have not been run.** `.railway/railway.ts`
  is edited and evaluates clean, but this session has no Backboard token — `plan` fails with
  "Backboard token is required for plan." Someone with Railway credentials has to run the
  plan/apply pair before the new variable and watch patterns take effect. AGENTS.md forbids
  hand-editing the dashboard.
- ~~**Measure the miss rate against real network recipes.**~~ Done — see "The miss rate,
  measured against real network recipes" below. The `unknown` threshold now has a measured
  distribution behind it; `may_contain` still has no corpus that triggers it.
- **`atproto-sync` has no queue-level `defaultJobOptions`,** so a hand-posted `atproto-sync` job
  is still retained forever. Fixing `server.ts` to pass `jobOptionsFor` would settle it for every
  workflow at once, and is the better fix than a second per-workflow default.

---

# The miss rate, measured against real network recipes

This section closes the open item above ("Measure the miss rate against real network
recipes"). It adds a second corpus, measures the matcher against it, and reports what that
does to the allergen verdicts. **Nothing in the classifiers, the lexicon, `traits.json` or the
enrichment workflow was changed** — the only files touched are the new seed and
`calibrate.db.test.ts`.

## Why the 0.0% was never a measurement of the lexicon

The baseline swept `1787000664088_dev_recipes.ts` and reported 396/396 lines resolved, and
`calibrate.db.test.ts` independently agreed at 338/338. Both are correct and both are
uninformative: that seed was hand-written alongside the lexicon it is being used to grade. A
corpus written by the same hand that wrote the matcher cannot produce a miss. The 0.0% was a
property of the corpus, not of `categorizeWith`.

## The new corpus

`services/web/src/db/seeds/1787688761627_network_recipe_corpus.ts` — **210 recipes, 39
authors, 1781 ingredient lines** (1745 ingredient lines plus 36 lines the parser flags as
group headers). Created with `pnpm --filter @buttery/web db:seed:make`, keyed `netseed-<id>`,
upserted, and it no-ops with the same "no household" message as the dev seed.

### How the sample was drawn

The dev database holds 4251 synced recipes, and a uniform random draw over them would have
been close to worthless: **4041 of the 4251 belong to a single DID** — 3695 Wikibooks Cookbook
imports plus 346 further rows in the same uniform machine style. A blind sample of 300 from
that pool would have been ~95% one importer, and would have reported one importer's house
style as "the network".

Measured separately, the three strata are genuinely different populations:

| stratum                                 | recipes | lines | line miss | recipe miss |
| --------------------------------------- | ------: | ----: | --------: | ----------: |
| A — Wikibooks import (`wb-*`, bulk DID) |    3695 | 31955 |     3.81% |       24.5% |
| B — same DID, non-`wb`                  |     346 |  2478 |     2.78% |       17.3% |
| C — everything else (39 other DIDs)     |     210 |  1745 |    12.21% |       45.7% |

**The committed corpus is a census of stratum C — all 210 of them, no sampling step at all.**
A census has no selection to bias: there was no point at which a recipe could be kept or
dropped for how it matched. Stratum A is already measured over all 3695 and is reported in the
table above, so adding a slice of it to the seed would have added bulk without adding
measurement.

### What was and was not changed

Nothing was changed for matching reasons. Every ingredient line is committed as it was
authored — brand names (`RO-TEL Original`, `Carrol Shelby's Texas Chili Kit`, `Cardini's
ceasar dressing`, `Badia Sazon Tropical`), loanwords and regional names (`doubanjiang`,
`kasuri methi`, `shiraga negi`, `potimarron`), whole French and Portuguese recipes, prep
clauses, parentheticals, unicode fractions, typos (`old-fashioned rolled outs`), and 36 group
headers. **Zero recipes were dropped, for any reason.**

For provenance, four things were removed, none of which touch a measured number:

- **All descriptions and instruction prose.** Ingredient lists are largely uncopyrightable
  facts; headnotes and method text are not, so the seed writes no `recipe_instruction` rows
  at all.
- **DIDs replaced with opaque author keys `a01`–`a39`.** Kept in some form because 210
  recipes from 39 authors is not 210 independent draws, and the confidence intervals below
  depend on knowing the clustering.
- **Four titles carrying a private given name** generalised (`Rebecca's …` → `…`).
- **Two ingredient lines carrying record locators** (an `at://did:plc:…` URI and a
  `recipe.exchange` permalink) replaced with same-shaped placeholders. Both were verified to
  parse and match identically before and after (`en:coating`, `en:pesto`), so no measured
  number moved.

A final sweep for residual identifiers — handles, DIDs, URLs, household names, personal notes
— returned none. Rows are written `origin: "local"`, `visibility: "private"`, with no
did/rkey/uri.

### Note on the seed key

The brief specifies `seed-<slug>`. The prefix used is **`netseed-`** instead, because
`1787000664088_dev_recipes.ts`'s `pruneStaleSeedRecipes` deletes _any_ recipe whose id is
`like 'seed-%'` and is not in its own keep-set. A second seed file using the documented
convention would have had its rows silently deleted on every `db:seed:run`, in filename order,
with no error. Recorded as `def-483885f6bc86`. Verified by running `db:seed:run` twice: 210
`netseed-` + 33 `seed-` + 4251 `sync` rows all intact, no cross-pruning.

## 1. Per-line miss rate

Measured with the real matcher (`parseIngredientLine` → `categorizeWith`), group headers
excluded as `isGroupHeader`:

| view                                                |     miss |      rate |
| --------------------------------------------------- | -------: | --------: |
| every ingredient line                               | 213/1745 | **12.2%** |
| distinct lines (what `calibrate.db.test.ts` sweeps) | 170/1548 | **11.0%** |

95% confidence interval on the per-line rate, bootstrapped **by author** rather than by line
(lines within one author's recipes are not independent): **5.0% – 24.2%**. The interval is
wide because 39 authors is not many clusters, and because two authors contribute nearly all of
the non-English lines.

156 distinct ingredient names went unresolved. 36 lines were excluded from every rate here as
group headers — but only 3 of them are true bare headers (`For Serving:`, `Marinade:`,
`Peanut Sauce:`). The other **33 are compound `Label: real ingredient` lines** — `For the lye
bath: 2 liters water` — which `parse-ingredient` mis-flags as headers because of the embedded
colon. Stripped of their labels and re-run through the matcher, **all 33 resolve.**

So the denominator here is 33 lines short, and every one of them would have been a hit: the
honest rate is 213/1778 = **11.98%**, marginally lower than the 12.2% quoted above. The error
runs against the matcher's favour, not for it, which is why the numbers were left as measured
rather than restated. It is an upstream parser quirk, not something this corpus introduced or
could control, and fixing it is its own piece of work — see the counterfactual table's row 1,
which prices a related header fix.

## 2. Per-recipe rate — the number that decides whether `not_detected` is reachable

The allergen rules emit `not_detected` only when **every** line resolved. So this is the number
that matters:

| corpus                           | ≥1 unresolved line | `not_detected` reachable |
| -------------------------------- | -----------------: | -----------------------: |
| all 210                          | 96/210 = **45.7%** |                **54.3%** |
| the 171 with ≥2 ingredient lines | 57/171 = **33.3%** |                **66.7%** |

The second row exists because 39 of the 210 recipes are structurally degenerate — 38 from one
author whose entire ingredient list is the single line `See original recipe`, plus one
`Test Recipe` whose only ingredient is `Love`. The "≥2 ingredient lines" filter is a structural
rule fixed **before** any match outcome was inspected, and it catches exactly those 39; the
nine genuine two-line recipes (Simple Syrup, Butter, and so on) all survive it.

So the answer to the question the brief cares about: **not "almost none", but roughly half to
two-thirds.** One recipe in three loses its allergen verdict entirely to a single unresolved
line — that is a real ceiling, but it is not a feature that fails to function.

## 3. The miss list

### Composition of the 213 missed lines

| what it is                                                  | lines | share |
| ----------------------------------------------------------- | ----: | ----: |
| non-English ingredient name (French, Portuguese)            |   112 | 52.6% |
| English food the lexicon does not resolve                   |    45 | 21.1% |
| placeholder / not an ingredient at all                      |    45 | 21.1% |
| markdown `## Heading` the parser failed to flag as a header |    11 |  5.2% |

Over half the miss rate is **not a lexicon gap at all** — it is a corpus containing recipes in
languages the Open Food Facts English taxonomy structurally does not cover. That is a real
property of the network and it will not go away, but it is a different problem from "the
lexicon is missing foods".

### Frequency-ranked, top of the list

```
 38  see original recipe        (38 recipes — one author's placeholder)
  4  de beurre
  3  de sucre
  2  ## toppings                (markdown header, not flagged)
  2  à café de cannelle
  2  à café de muscade
  2  de farine
  2  gousses d'ail
  2  gousses d’ail              (straight vs curly apostrophe — two distinct names)
  2  huile d’olive
  2  kasuri methi
  2  manteiga
  2  œuf
  2  oeufs
  2  pincée de sel
  2  poivre noir
  2  whole                      ("2-3 whole, peeled cloves of garlic" — parser took "whole")
```

The tail is long and flat: **138 of the 156 distinct missed names occur exactly once.** There
is no fat head of common English foods to fix.

### Cheap fix vs. genuinely absent, for the English gap

`scripts/food-synonyms.ts` / `EXTRA_FOODS` can close a miss only if the Open Food Facts
taxonomy carries the food. Probed against `lexicon.foods` and `lexicon.index`:

**In the taxonomy — a synonym or plural away (cheap):**

| missed name                               | taxonomy has                       | why it missed                      |
| ----------------------------------------- | ---------------------------------- | ---------------------------------- |
| `cloves`, `ground cloves`, `whole cloves` | `en:clove`, `en:ground-clove`      | index carries only `clove`         |
| `kasuri methi`, `kasoori methi`           | `en:dried-fenugreek-leaf`          | loanword spelling, no synonym      |
| `chuck roast`, `ground chuck`             | `en:chuck-steak`                   | cut name variant                   |
| `farro`                                   | `en:pearled-farro`                 | only the processed form indexed    |
| `haloumi`                                 | `en:halloumi`                      | spelling                           |
| `kirschwasser`                            | `en:kirsch`                        | full name vs. short                |
| `cornichons`                              | `en:gherkin`                       | loanword                           |
| `creme double`                            | `en:double-cream`                  | loanword                           |
| `old-fashioned rolled outs`               | `en:oat` (via `rolled oats`)       | typo in the source, not our gap    |
| `blackcurrants` / `redcurrants`           | `en:blackcurrant`, `en:redcurrant` | plural                             |
| `graham crackers`                         | `en:graham-flour` only             | _partial_ — a cracker is not flour |
| `caper brine`                             | `en:capers` only                   | _partial_ — brine is not the caper |

**Not in the taxonomy — not fixable in the synonym file, and this is the evidence about what
phase 2 would need:**

`orzo`, `gnocchi`, `manicotti`, `polenta`, `masa harina`, `prosciutto`, `soppressata`,
`schnitzel`, `chashu`, `pretzels`, `mirepoix`, `doubanjiang`, `shiraga negi`, `sazón`,
`adobo powder`, `ranch`, `whipped topping`, `gel food coloring`, `Pinot Gris` (no wine
varietals at all), and — the one worth flagging — **`saffron`**, which exists in the taxonomy
only as `en:saffron-milk-cap`, a mushroom. The spice is absent.

Pattern: the Open Food Facts ingredient taxonomy is strong on raw commodities and weak on
**prepared and named products** — pasta shapes, cured meats, cuisine-specific pastes,
condiment brands. That is precisely the register real recipes are written in.

### Counterfactuals

What each layer of fixing would actually buy:

```
0  as measured today                       line 213/1745 = 12.2% | recipes 96/210 = 45.7% | not_detected reachable  54.3%
1  + parser flags '## x' as a header       line 202/1734 = 11.6% | recipes 93/210 = 44.3% |                         55.7%
2  + placeholder rows excluded             line 157/1689 =  9.3% | recipes 50/171 = 29.2% |                         70.8%
3  + non-English resolved (multilingual)   line  45/1689 =  2.7% | recipes 31/171 = 18.1% |                         81.9%
4  + every English gap closed as well      line   0/1689 =  0.0% | recipes  0/171 =  0.0% |                        100.0%
-- English-only corpus (non-English dropped, not fixed)
                                           line  45/1577 =  2.9% | recipes 31/166 = 18.7% |                         81.3%
```

The single largest lever is **multilingual resolution**, not more synonyms. Closing every
English gap in the corpus on top of that moves the per-recipe rate a further 18 points; doing
it _without_ multilingual support leaves the ceiling at ~81%.

## 4. Verdict distribution

`POST /jobs/recipe-enrichment` with `{"name":"backfill","data":{"limit":500,"localOnly":true}}`.
`localOnly` was added to the documented payload so the claim scopes to `origin='local'` — the
243 seeded recipes — and leaves the 4251 unrelated synced rows out of the run. All 243
completed `ok`.

**Allergen, 210 network recipes × 10 slugs = 2100 labels:**

| verdict        | network corpus |     share | dev corpus (baseline) |
| -------------- | -------------: | --------: | --------------------: |
| `contains`     |            219 |     10.4% |                    65 |
| `not_detected` |            977 |     46.5% |                   265 |
| `may_contain`  |          **0** |      0.0% |                     0 |
| `unknown`      |        **904** | **43.0%** |                 **0** |

The baseline recorded above reads 71/279; re-running it today over the same seed file gives
65/265. The seed file has not changed since its only commit — the earlier run's database held
two extra `origin='local'` rows that were never part of any seed file (`d-e67628b7`, resolved
`d-5deceed8`). The shape of the baseline is unaffected.

Per recipe, allergen labels:

| unresolved lines                 |         recipes |
| -------------------------------- | --------------: |
| 0 unknown labels (all 10 usable) | **114** (54.3%) |
| 6–9 unknown                      |              30 |
| 10 unknown (nothing usable)      |              66 |

The 96 recipes with ≥1 unresolved line are exactly the 96 with ≥1 unknown allergen label — but
30 of them still get a usable `contains` on some allergens, because a positive match on a
resolved line stands regardless of what else failed to resolve. **The rules degrade
gracefully**, which is worth knowing: an unresolved line suppresses `not_detected` but does not
suppress a detection.

`may_contain` is still **zero**, exactly as at baseline. The unresolved-line path was expected
to be what finally triggered it; it does not, because `unknown` claims those recipes first.
That path remains untested by any corpus.

**Diet, 210 × 13 = 2730 labels:** 398 `excluded`, 384 `likely`, 1948 `unknown` (71.4%). But
**1260 of those unknowns — 64.7% — are structural, not lexical**: six slugs (`keto`,
`low_carb`, `low_fat`, `low_calorie`, `diabetic`, `paleo`) are 210/210 unknown because they
need nutrition data the rules do not have. Excluding those six, diet unknown is 688/1470 =
46.8%, in line with allergen.

## What was done about the calibration test

Option 1 from the brief. `calibrate.db.test.ts` used to sweep _every_ distinct
`recipe_ingredient.text` row in the database, which meant its corpus was whatever happened to
be in that developer's dev database — on this machine 94.4% (dragged up by 4251 synced
Wikibooks lines), on a seeds-only database 91.0%. The asserted number was never attributable to
a corpus.

Each assertion now scopes itself by recipe-id prefix, and there are two:

- `seed-%` — the dev corpus, target **90%** unchanged, achieves **100.0%** (330/330).
- `netseed-%` — the network corpus, floor **85%**, achieves **89.0%** (1378/1548).

The network floor sits below its measured rate on purpose, with the reasoning in the constant's
own doc comment: a floor pinned at the measurement goes red on one line of drift and teaches
people to edit the number, while a floor with ~60 lines of headroom stays quiet through
ordinary churn and goes red when a synonym pass or parser change costs real coverage. It is
lower than 90% because the corpora differ, not because the target was relaxed — over half the
misses are non-English. If phase 2 adds multilingual resolution it should be raised.

**The honest rate did land below 90%** (89.0% on distinct lines), so this was not a hypothetical.
No line was edited to lift it. `pnpm --filter @buttery/web exec vitest run --project db`:
9 files, 260 tests, all passing.

## Does the data support `MEANINGFUL_UNRESOLVED_SHARE = 1/3`?

Yes — but almost any value between 0.25 and 0.67 would do equally well, and that is the finding.

Share of recipes forced to `unknown` at each candidate threshold:

| threshold |   all 210 | ≥2-line subset |
| --------- | --------: | -------------: |
| 0.10      |     39.0% |          25.1% |
| 0.20      |     29.0% |          12.9% |
| 0.25      |     27.6% |          11.1% |
| **0.333** | **27.1%** |      **10.5%** |
| 0.40      |     26.2% |           9.4% |
| 0.50      |     26.2% |           9.4% |
| 0.667     |     25.2% |           8.2% |

The unresolved-share distribution is strongly **bimodal**: p50 = 0.0%, p75 = 75%, p90/p95/p99 =
100%. Recipes either resolve cleanly or fail almost completely — the 100% tail is the
`See original recipe` placeholder rows. Very little mass sits between a quarter and two thirds,
so the threshold has almost nothing to cut. Moving it from 1/3 to 1/2 changes 0.9 percentage
points of recipes; moving it to 0.10 changes 12.

Where it _does_ bite is the confidence tier, and there it is doing visible work: of the 904
`unknown` allergen labels, **567 carry confidence 0.15** (unresolved share ≥ 1/3, spread over
57 recipes) and **337 carry 0.40** (below the threshold, 39 recipes). That is a real 60/40
split, not a degenerate one.

**Recommendation: leave it at 1/3.** It is now a judgement backed by a measured distribution
rather than by nothing, and the measurement says the choice barely matters. The number worth
revisiting is not this one — it is that `may_contain` still has no corpus that triggers it.

## What might still make this sample unrepresentative

Stated plainly, since the last corpus's bias went unnoticed:

- **39 authors, not 210 independent draws.** One author supplies the 38 `See original recipe`
  rows; two supply nearly all the French and Portuguese. The author-clustered CI (5.0%–24.2%)
  is wide for exactly this reason, and a different 39 authors could land anywhere in it.
- **It is a census of one stratum, not of the network.** Stratum C is "recipes from this dev
  database that are not the bulk importer's". What that population represents is "whatever
  this dev database happened to sync", which is not a random sample of atproto.
- **The stratum boundary was drawn with the per-stratum miss rates already known.** The
  decision that fixed it (`d-64be66fe`) cites 3.81% / 2.78% / 12.21% as its justification, so
  strictly this is a matching-outcome-informed choice at the boundary, even though there is no
  per-recipe or per-line discretion inside it. Two things cut against it being a thumb on the
  scale: the stratum chosen is the one that matches **worst**, which is the opposite of a
  flattering pick, and the provenance argument — that 95% of the pool is one importer, so a
  uniform draw would measure one house style — holds whatever the rates had turned out to be.
  Recorded here rather than left implicit, because a boundary drawn after seeing the outcome is
  exactly the kind of thing the 0.0% corpus taught us not to leave unstated.
- **A dev database is not production.** These are the accounts this instance follows.
- **Non-English share is a corpus property, and it dominates.** 52.6% of the miss rate is
  French and Portuguese from a handful of authors. A corpus with two fewer francophone authors
  would report a per-line rate near 6% and a very different conclusion about what to fix.
- **Instruction prose was dropped**, so this corpus cannot be used to measure anything that
  reads method text — the `may_contain` cross-contamination triggers included.
- **The 4251 stratum-A/B rows stay in this dev database** and are not part of the seed. Anyone
  reproducing these numbers on a fresh seeded database gets the 210 only, which is what the
  scoped calibration test now measures.
