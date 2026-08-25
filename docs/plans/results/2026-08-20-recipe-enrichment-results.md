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
- **Measure the miss rate against real network recipes.** See the conjecture above. Until then,
  the `may_contain` and `unknown` allergen thresholds are set by judgement rather than by data.
- **`atproto-sync` has no queue-level `defaultJobOptions`,** so a hand-posted `atproto-sync` job
  is still retained forever. Fixing `server.ts` to pass `jobOptionsFor` would settle it for every
  workflow at once, and is the better fix than a second per-workflow default.
