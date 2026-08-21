# 2026-08-20 — Recipe enrichment pipeline

Status: **spec — ready to implement**
Depends on: the BullMQ pipeline branch (`services/pipeline`, `defineWorkflow`, the
`atproto-sync` workflow) — this plan builds the **second** workflow on that kernel and is
therefore not mergeable to `main` before it.
Related: `2026-08-11-grocery-list.md` §4 (the Open Food Facts food lexicon this reuses),
`03-household-recipe-collection.md` (the rendered `recipe` layer and `recipe_vocab`).

> Implementer: log outcomes to `docs/plans/results/2026-08-20-recipe-enrichment-results.md`
> (what was built, how it was verified, deliberate deviations, and the measured label
> coverage — how many recipes came back `ok`, and the share of ingredient lines the lexicon
> failed to resolve, because that number is what decides whether phase 2 is worth it).

---

## 1. Context

Buttery indexes recipes from two sources: the atproto network (the `atproto-sync` workflow
renders `recipe` rows with `origin='sync'`) and the app itself (`persistRecipeDraft` writes
`origin='local'`). **Neither source can be trusted to say what a dish is.** The
`exchange.recipe.recipe` lexicon has a `suitableForDiet` field and a `nutrition` object, but
both are author-supplied, usually absent, and never verifiable. Most imported recipes carry
neither, and the ones that do carry them are asserting, not proving.

The Randomizer — a `soon` chip in the nav today — has to answer "roll me a dinner that is not
going to hurt anyone in this house." That needs derived, per-recipe facts: which of the FDA
Big 9 allergens plus gluten the _ingredients_ imply, and which common diets the dish is
compatible with. Later it wants rough nutrition too. Deriving those is expensive and must
never block a save, so it belongs in the BullMQ pipeline that already exists.

This is **purely a Buttery enhancement**. Nothing here is ever written into an
`exchange.recipe.recipe` record or published to a PDS — the same rule the `recipe_meta`
sidecar already lives under.

### 1.1 In scope

1. Two tables — `recipe_enrichment`, `recipe_enrichment_label` — plus a new `allergen`
   dimension and two new `diet` slugs in `recipe_vocab`.
2. `packages/food`: the existing `services/web/src/lib/grocery/` engine extracted to a
   workspace package so the pipeline can use it, plus a new generated `traits.json` carrying
   vegan/vegetarian/allergen facts per food.
3. `packages/pipeline-contract`: the queue and step names both the app and the pipeline
   depend on.
4. `ctx.enqueue` — a kernel primitive for handing work to a _different_ workflow.
5. The `recipe-enrichment` workflow: `enrich`, `backfill`, `backfill-report`.
6. Rules-based allergen and diet classifiers, with an LLM-shaped seam.
7. Triggers from both write paths — the app and the sync.
8. A server read helper and a dev-only debug panel on the recipe detail page.

### 1.2 Out of scope (seams only)

- **Nutrition estimation.** The columns land; every one of them stays null in v1. See §13.
- Any LLM call. §8's `Classifier[]` array is the seam; nothing is stubbed into the graph.
- Any Randomizer UI or query. This plan produces the facts it will read, nothing more.
- Any user-facing display of labels outside the dev panel, and any user correction UI.
- Any change to what is published to atproto.
- Automatic reprocessing on a `classifier_version` bump. Backfill is a deliberate act (D15).

---

## 2. Decisions locked

| #   | Decision                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Dedicated tables, not columns on `recipe`.** Derived facts never share a row with author-declared ones. `recipe.suitable_for_diet`, `recipe.calories` and the `*_content` columns are **never written** by this pipeline. |
| D2  | **Deterministic rules over the Open Food Facts taxonomy** in v1. An LLM is a later _provider_ added to the classifier array, not a stubbed branch shipped dead today.                                                       |
| D3  | **Writers mark `status='stale'` inside their own transaction, then enqueue best-effort.** The row is the durable signal; the job is the latency optimisation. A failed enqueue costs freshness, never correctness.          |
| D4  | Coverage: local/private/boxed recipes are enriched eagerly on write. Public synced recipes are fanned out by `atproto-sync` as it renders them.                                                                             |
| D5  | **Allergen verdicts are 4-state** — `contains`, `may_contain`, `not_detected`, `unknown` — and `not_detected` is **not** a safety claim. Nothing may render it as "free of".                                                |
| D6  | Diet verdicts are 3-state — `excluded`, `likely`, `unknown`. There is no "certified" state and there never will be from rules.                                                                                              |
| D7  | Taxonomy: **FDA Big 9 plus gluten** (`milk, egg, fish, crustacean_shellfish, tree_nuts, peanut, wheat, soy, sesame, gluten`). `diet` gains `pescatarian` and `dairy_free`.                                                  |
| D8  | The food lexicon moves out of `services/web` into **`packages/food`**, unchanged. The pipeline is its second consumer; both get the identical matcher.                                                                      |
| D9  | Food traits ship as a **second generated file** (`traits.json`), not extra keys on `lexicon.json` — traits are server-only and the client bundle's 100KB gzip budget stays untouched.                                       |
| D10 | Enrichment identity is `contentFingerprint(name, ingredients)`, the same hash `render.ts` and the web write path already use. Order-independent by construction.                                                            |
| D11 | **`on delete cascade` on both new tables.** `household_recipe` and `meal_plan_entry` use `RESTRICT` and cost `render.ts` two explicit guard clauses; a derived table must not add a third.                                  |
| D12 | **No `recipe_vocab_alias` rows for `allergen`.** No upstream `exchange.recipe.defs` token maps to it, so `registerToken()` in `render.ts` structurally cannot auto-register into the dimension.                             |
| D13 | Cross-workflow handoff uses a new `ctx.enqueue`, not `ctx.flow`. Flow children would make `atproto-sync`'s `finalize` wait on every enrichment and hold the sweep lock for the duration.                                    |
| D14 | The unit of work is **one recipe**. No overlap lock — BullMQ already refuses to run the same job twice, and a deterministic `enrichJobId(recipeId)` collapses duplicate triggers.                                           |
| D15 | **Manual backfill only.** No schedule, no boot-time re-enqueue. A `classifier_version` bump rides a deploy; reprocessing the corpus is a decision someone makes.                                                            |
| D16 | Read surface in v1 is a server helper plus a **dev-gated** panel — gated on `import.meta.env.DEV` on the client _and_ re-checked server-side.                                                                               |

---

## 3. Data model

One migration, created with `pnpm --filter @buttery/web db:migrate:new create_recipe_enrichment`
— **never hand-name a migration** (AGENTS.md) — then `db:migrate:up` followed by `db:codegen`.

### 3.1 `recipe_enrichment` — one row per recipe

```
recipe_id            text primary key references recipe(id) on delete cascade
status               text not null default 'stale'   -- stale | ok | error
classifier_version   int  not null default 0
input_hash           text                            -- sha256 of name + ingredients
enriched_at          timestamptz
error                text

-- phase 2 (§13). Written by nothing in v1; every one of these stays null.
nutrition_method     text                            -- null | 'usda-fdc' | 'llm'
servings             numeric
calories_per_serving int
fat_g                numeric
protein_g            numeric
carbohydrate_g       numeric
fiber_g              numeric
sugar_g              numeric
sodium_mg            numeric
nutrition_confidence numeric
```

`status` is the whole trigger protocol. A writer that touches a recipe sets `stale` and moves
on; the worker sets `ok` or `error`. Anything that is `stale` and old is, by definition,
something the backfill will find — that is what makes D3's best-effort enqueue safe.

`error` holds the message, not a stack. The `atproto_sync_run` lesson applies: a failure that
writes nothing is a failure nobody can see.

### 3.2 `recipe_enrichment_label` — one row per (recipe, dimension, slug)

```
recipe_id   text not null references recipe(id) on delete cascade
dimension   text not null                 -- 'diet' | 'allergen'
slug        text not null
verdict     text not null
confidence  numeric not null              -- 0..1
method      text not null                 -- 'rules@1'; later 'llm:claude-…'
evidence    jsonb                         -- which lines and food slugs fired, and which rule
updated_at  timestamptz not null default now()

primary key (recipe_id, dimension, slug)
foreign key (dimension, slug) references recipe_vocab (dimension, slug) on delete cascade
```

Verdict vocabulary differs per dimension, and one check constraint enforces both:

```sql
check (
  (dimension = 'allergen' and verdict in ('contains','may_contain','not_detected','unknown'))
  or (dimension = 'diet'   and verdict in ('excluded','likely','unknown'))
)
```

> **`not_detected` is not a safety claim.** It means the rules found nothing, over free text
> they may not have fully parsed. Consumers exclude on `contains` and `may_contain`; nothing
> in this codebase may present `not_detected` as "free of".

That sentence goes in the migration as a comment and at the top of the classifier module. It
is the single most important line in this plan.

`method` is per-label, not per-row, because the point of §8's seam is that an LLM can later
overwrite one recipe's `allergen/sesame` while the rules keep owning the rest.

### 3.3 Indexes

- `recipe_enrichment_label (dimension, slug, verdict, recipe_id)` — the Randomizer's exclusion
  scan: "every recipe where `allergen/peanut` is `contains` or `may_contain`".
- `recipe_enrichment (status, classifier_version)` — the backfill claim in §7.2.
- Per-recipe reads are already covered by the label PK's leading `recipe_id`.

### 3.4 Vocabulary additions (same migration)

Follow the `seedVocab` pattern in `1785300000000_create_recipe_rendered.ts`.

- New `allergen` dimension, ten slugs: `milk`, `egg`, `fish`, `crustacean_shellfish`,
  `tree_nuts`, `peanut`, `wheat`, `soy`, `sesame`, `gluten`.
- `diet` gains `pescatarian` and `dairy_free` alongside the eleven upstream slugs.

Insert `recipe_vocab` rows only. **No `recipe_vocab_alias` rows** (D12): aliases exist to map
an upstream `exchange.recipe.defs#…` token onto an internal slug, and none of these have one.
`registerToken()`'s `DIM_PREFIX` map in `render.ts` has no `allergen` entry, so a hostile
record cannot invent an allergen — as long as nobody adds one.

`source` on the new rows marks them as Buttery-internal rather than lexicon-derived, matching
however the existing seed distinguishes them.

---

## 4. `@buttery/food` — extract the food lexicon

`services/web/src/lib/grocery/` already solves ingredient-line → food identity, and it is
exactly what the classifiers need. It cannot stay in `services/web`: the pipeline is a separate
deployable and must not import across service boundaries.

New source-only workspace package `packages/food`, matching `packages/recipe-schemas` — no
build step, `exports` map pointing straight at `.ts`, `tsconfig.base.json` with
`"lib": ["ES2022"]` and no DOM.

Moves, unchanged: `aisles.ts`, `normalize.ts`, `parse.ts`, `units.ts`, `categorize.ts`,
`lexicon.json`, `lexicon.LICENSE.md` (the ODbL notice travels with the data — AGENTS.md), and
the `parse.test.ts` / `units.test.ts` / `categorize.test.ts` suites, which test only moved
modules.

Stays in `services/web`, re-pointed at the package: `merge.ts` (grocery-list specific),
`merge.test.ts`, `calibrate.db.test.ts` (needs the web DB).

Also re-point: the seven `#/lib/grocery/*` import sites in web, `scripts/build-food-lexicon.ts`
(`OUT_DIR` plus two imports), `scripts/food-aisle-map.ts`, `scripts/food-synonyms.ts`,
`scripts/tsconfig.json`'s `include`, and the AGENTS.md line naming the generated lexicon path.
`parse-ingredient` moves to the package's dependencies.

`parse.ts`'s `parseIngredient` dependency and `categorize.ts`'s dynamic `import("./lexicon.json")`
both survive the move as-is; the dynamic import is what keeps the ~600KB of JSON out of any
bundle that never categorizes.

### 4.1 New generated artifact: `packages/food/src/traits.json`

The vendored `lexicon.json` flattened the taxonomy to `{aisle, name, staple, ignored}` and
**discards property lines** — `parseTaxonomy()` bails on any key that fails its `LANG_KEY`
test. But Open Food Facts' `ingredients.txt` carries `vegan:en: yes|no|maybe` and
`vegetarian:en: yes|no|maybe` on many nodes, and its parent hierarchy is what makes allergens
tractable at all. Extend the build script to emit a second file:

```jsonc
{
  "en:mozzarella": { "vg": 0, "vt": 1, "al": ["milk"] }, // 0 = no, 1 = yes, 2 = maybe
}
```

- **Diet properties**: capture `vegan:en:` / `vegetarian:en:` in `parseTaxonomy`, then inherit
  down the hierarchy with the existing `nearestMapped()` ancestor walk.
- **Allergens**: from a curated seed map, `scripts/food-allergens.ts`, in the same spirit as
  `food-aisle-map.ts` — OFF id → allergen slug (`en:milk → milk`, `en:almond → tree_nuts`,
  `en:soy-sauce → soy` _and_ `wheat`). Inheritance needs a **new** helper beside
  `nearestMapped`: allergens accumulate over the whole ancestor closure rather than stopping
  at the nearest hit, because one food carries several — `en:pesto` is milk _and_ tree nuts.
  The existing multi-parent, cycle-safe BFS is the right walk; only the fold changes.

A second file rather than extra keys on `lexicon.json` (D9), so the client bundle and the
existing `MAX_GZIP_BYTES = 100 * 1024` assertion are untouched. Give `traits.json` its own
budget assertion in the build script.

Bump `SOURCE_COMMIT` and land the regenerated JSON in the same commit as the script change —
the existing rule in AGENTS.md.

---

## 5. `packages/pipeline-contract`

~40 lines, zero dependencies: the queue name, the step names, the `EnrichPayload` type, and
`enrichJobId(recipeId)` for BullMQ's deterministic-id dedupe.

Imported by both `@buttery/pipeline` and `@buttery/web`. Its whole job is to make it impossible
for a rename to leave the app enqueueing into a queue nobody drains — today that mistake fails
silently, because `queue.add` on an undrained name succeeds.

---

## 6. `ctx.enqueue` — a kernel primitive

`ctx.flow()` builds a graph inside one workflow's own queue. `atproto-sync` needs to hand work
to a _different_ workflow without those jobs becoming children of its graph: a `finalize` that
waited on thousands of enrichments would hold the sweep's hour-TTL Redis lock for the whole
time, and the next scheduled sweep would be skipped (D13).

Add `enqueue` alongside `flow` in `services/pipeline/src/workflows/define.ts` — on
`StepContext`, on `WorkflowHost`, and in the `run` wiring:

```ts
enqueue: (workflow: string, node: { step?: string; data?: unknown; opts?: JobsOptions }) => Promise<void>;
```

- **`jobHost`** (`hosts.ts`): resolve the target queue from `getQueues()`, merge the _target_
  workflow's `jobOptionsFor(step)`, `queue.add(...)`. An unknown workflow name throws — same
  reasoning as `defineWorkflow`'s existing entry-step check: a typo should fail loudly at the
  call, not vanish into a queue that does not exist.
- **`consoleHost`**: log the intent and skip. That is honest for `run-once` — cross-workflow
  work is another workflow's run, not this one's, and pretending otherwise would make
  `sync:once` silently do a corpus-wide enrichment on a laptop.
- **`worker.ts`**: pass `getQueues(config.redisUrl)` into `jobHost`.

---

## 7. The `recipe-enrichment` workflow

New folder `services/pipeline/src/workflows/recipe-enrichment/`, one entry added to `WORKFLOWS`
in `workflows/index.ts` — the only registration that exists (AGENTS.md). Layout mirrors
`atproto-sync/`: `index.ts` (the `defineWorkflow` call and the module doc), `steps.ts`,
`types.ts`, `classify.ts` (pure, tested), `lib/db.ts` (its own lazy pool plus `close`), and
`classifiers/`.

```
enrich                                        one recipe — the entry step
backfill ──fans out──▶ enrich × N ──▶ backfill-report
```

### 7.1 `enrich` (entry) — payload `{ recipeId, force? }`

1. Load `recipe.name` and the `recipe_ingredient` lines ordered by `ordinal`. A missing recipe
   completes as `{status: "gone"}` — a deleted recipe is not a failure, and jobs outlive rows.
2. `contentFingerprint(name, ingredients)` from `@buttery/recipe-schemas/normalize`. Already
   used by `render.ts`, the web write path, and a backfill migration; it sorts and normalizes
   lines, so it is exactly the order-independent identity classification wants (D10). If it
   matches the stored `input_hash` **and** `classifier_version` is current **and** `status='ok'`
   **and** not `force`, return `{status: "unchanged"}` without running a classifier.
3. `parseIngredientLines()` → `categorizeWith(lexicon, …)` per line → `{foodSlug, via, quantity}`.
4. Run every classifier in the array; each returns `Label[]`.
5. **One transaction**: delete this recipe's labels, insert the new ones, upsert
   `recipe_enrichment` with `status='ok'`, the new hash, the current `classifier_version` and
   `enriched_at`. A thrown error is caught outside that transaction and written as
   `status='error'` plus the message.

`jobOptions`: `attempts: 3`, exponential backoff from 5s, `removeOnComplete: {count: 200}`,
`removeOnFail: {count: 500}`. A payload with no `recipeId` throws `UnrecoverableError` —
retrying a malformed payload three times is three wasted slots.

### 7.2 `backfill` — payload `{ limit?, force?, localOnly? }`

Claims a bounded batch — `limit`, default 500, hard cap 5000 — from
`recipe left join recipe_enrichment` where the enrichment row is missing, or `status <> 'ok'`,
or `classifier_version <` the current one. Ordering is deliberate: `origin='local'` first, then
recipes with a `household_recipe` row, then everything else. Somebody's own recipes are worth
more than the long tail of the network, and a run that gets cut short should have spent its
budget on them.

Fans the claimed ids out as `enrich` children under a `backfill-report` parent, which folds
`children()` and logs how many candidates remain — so a second POST is an informed decision
rather than a guess.

Reached with `POST /jobs/recipe-enrichment` and `{"name": "backfill"}`; the existing endpoint
already takes a step name in `body.name`. **No schedule and no boot-time re-enqueue** (D15).

### 7.3 Workflow options

```ts
globalConcurrency: () => Number(process.env.RECIPE_ENRICHMENT_MAX_IN_FLIGHT || 16) || undefined;
close: closeDb;
```

The fleet-wide in-flight cap is what stops an `atproto-sync` sweep of thousands of repos from
swamping the fleet: the producer never throttles, the queue is the buffer (AGENTS.md). No
overlap lock (D14).

---

## 8. Classifiers

`classifiers/index.ts` exports an ordered `Classifier[]`. A classifier is
`(input: ClassifierInput) => Label[]`, where `ClassifierInput` carries the recipe name, the raw
lines, the parsed ingredients, the matched food slugs, and their traits from §4.1.

**Adding an LLM later is adding one module to that array.** That is the entire seam — no dead
step in the graph, no stubbed branch, nothing shipped today that does nothing (D2).

### 8.1 `classifiers/allergen.ts` — Big 9 plus gluten

- `contains` — a matched `foodSlug` carries the allergen in `traits.json`.
- `may_contain` — a text-level pattern fires on a line the lexicon did **not** resolve; or the
  matched food's trait is `maybe`; or the line names an ambiguous carrier ("stock", "broth",
  "sauce", "may contain").
- `not_detected` — **only** when every line resolved to a food slug and none carried it.
- `unknown` — a meaningful share of lines did not resolve. The threshold lives in one named
  constant, not scattered through the rules.

### 8.2 `classifiers/diet.ts`

Real verdicts for `vegetarian`, `vegan`, `pescatarian`, `dairy_free`, `gluten_free`, leaning on
OFF's own `vg`/`vt` properties — which is exactly why §4.1 exists.

`excluded`-or-`unknown` only for `halal` and `kosher`: pork and alcohol, plus shellfish and
meat/dairy co-occurrence for kosher. Enough to exclude a dish, never enough to certify one.
There is no rule over an ingredient list that establishes a supervised kitchen, and the schema
has no state that would let us pretend otherwise (D6).

`keto`, `low_carb`, `low_fat`, `low_calorie`, `diabetic` are macro-dependent: emit `unknown`
with a comment naming §13. They become answerable when nutrition does.

### 8.3 Rules that apply to every classifier

Every label records `confidence`, `method` and `evidence`. Evidence is what makes the debug
panel worth building and what makes a wrong verdict diagnosable instead of mysterious — "this
recipe is not vegetarian _because line 7 is fish sauce_".

**Never write to `recipe.suitable_for_diet`, `recipe.calories` or the `*_content` columns**
(D1). Those are what the author declared. When a declared diet contradicts a derived verdict,
both stand and the evidence explains the gap; what to do about the disagreement is the
Randomizer's problem, and it needs both halves to decide.

`classify.ts` is pure and gets a plain vitest suite over hand-written ingredient lists — fish
sauce in a "vegetarian" curry, gelatin in a dessert, Worcestershire, ghee, lard, marzipan,
tahini, soy sauce (wheat), oyster sauce. Every one of those is a dish somebody would otherwise
have mislabelled by hand.

---

## 9. Triggers

Both writers do the same two things: mark stale in their own transaction (the durable signal),
then enqueue best-effort (the latency optimisation). If the enqueue fails, the row is still
stale and §7.2 will find it (D3).

**Web** — `services/web/src/server/recipes-write.ts`. Add `bullmq` to `@buttery/web`; a new
`services/web/src/server/enrichment-queue.ts` builds a producer-only `Queue` on the shared
`getRedis()` client and adds a job with `jobId: enrichJobId(recipeId)`. Wire into
`insertLocalRecipe` (inside its existing transaction) and the publish path. Import `bullmq`
dynamically inside the handler so it stays out of the client bundle — the repo's standing rule
for `pg`.

**Sync** — `services/pipeline/src/workflows/atproto-sync/lib/render.ts`. `renderRecipe` already
knows precisely when a sync row's content advanced: the `res.rowCount > 0` branch after the
rev-guarded upsert, which is also where it re-derives children and search. Mark stale there, on
the same per-DID client. Collect the advanced recipe ids, return them up through `sweepDid` to
the `sync-repo` step, and have that step call
`ctx.enqueue("recipe-enrichment", { step: "enrich", data: { recipeId } })` per id.

Enqueue from `sync-repo`, not `finalize`: `finalize` would have to carry thousands of ids
through a Redis job payload, and per-repo enqueue spreads the load across the sweep instead of
spiking at the end of it.

---

## 10. Read surface

`services/web/src/server/recipe-enrichment.ts` — server-only, thin, in the same spirit as
`recipe-meta.ts` (including its "NEVER PUBLISHED" header):

- `getRecipeEnrichment(db, recipeId)` → the row plus its labels grouped by dimension.
- A `createServerFn` wrapper for the panel, authorized through the existing
  `recipe-context.ts` / `authz.ts` path so it cannot leak another household's recipe.

Panel on `services/web/src/routes/household.recipes.$id.tsx`, rendered only when
`import.meta.env.DEV` **and** re-checked server-side (`process.env.NODE_ENV !== "production"`),
so the server fn cannot be called in production even if the client gate is bypassed. It shows
status, classifier version, per-label verdict, confidence, method, and the evidence lines that
fired. Semantic tokens only, no raw hex (AGENTS.md).

---

## 11. Config and infra

- `services/pipeline/.env.example`: `RECIPE_ENRICHMENT_MAX_IN_FLIGHT`, commented, default 16.
- `.railway/railway.ts`: the same var on `pipeline` and `pipelineWorker`; add
  `packages/food/**` and `packages/pipeline-contract/**` to `pipelineBuild.watchPatterns`
  (currently only `packages/recipe-schemas/**`) and to the web service's watch patterns. Then
  `railway config plan` → `railway config apply`. Never hand-edit the dashboard.
- `AGENTS.md`: one line under Workflow Rules noting the second workflow and the `ctx.enqueue`
  primitive, in the file's existing voice. Update the generated-lexicon path in the same pass,
  since §4 moves it.

---

## 12. Verification

```
pnpm --filter @buttery/food test          # parser/matcher suites, moved intact
pnpm --filter @buttery/pipeline test      # classify.ts unit suite, define.ts enqueue
pnpm --filter @buttery/web test
pnpm lint && pnpm typecheck               # lexicons must be built first
```

DB-touching checks need `!` in the prompt or a sandbox-disabled call (AGENTS.md):

1. `db:migrate:up`, then `db:codegen`; confirm `recipe_enrichment` and
   `recipe_enrichment_label` appear in `src/db/types.ts`.
2. `pnpm --filter @buttery/pipeline test:db` and `pnpm --filter @buttery/web test:db` — new
   `*.db.test.ts` covering the `enrich` transaction, the cascade delete (assert that deleting a
   `recipe` takes its enrichment with it and does **not** raise 23001), and the backfill claim
   query's ordering.
3. Load the `local-dev` skill and bring the stack up. Save a recipe at `http://127.0.0.1:3000`
   (never `localhost`), then check the Bull Board at `http://127.0.0.1:3002/ui` for a
   `recipe-enrichment / enrich` job, and the dev panel on the recipe page for its labels.
   Verify pages with Chrome MCP, not `curl`.
4. Seed a deliberately tricky recipe — a "vegetarian" pad thai with fish sauce — and confirm
   `diet/vegetarian = excluded` with the fish sauce line as evidence, and `allergen/fish =
contains`.
5. `curl -X POST http://127.0.0.1:3002/jobs/recipe-enrichment -H 'content-type: application/json' -d '{"name":"backfill","data":{"limit":50}}'`
   and watch the fan-out and the report in the board.
6. Point the sync at the local dev-env PDS and run `pnpm --filter @buttery/pipeline sync:once`;
   confirm rendered sync recipes come back `stale`, and that a queued sweep
   (`POST /jobs/atproto-sync`) enqueues enrichment jobs.

---

## 13. Phase 2 — nutrition

The columns in §3.1 exist so the estimator lands as a migration-free change. It is deliberately
not in this PR, for a reason worth writing down: **Open Food Facts has no per-ingredient
nutrition data.** It is a product/barcode database — a jar of a specific brand of peanut butter
— and the taxonomy Buttery vendored from it is names and hierarchy, not nutrients. The free
dataset that actually answers "how many calories in 100g of raw chicken breast" is USDA
FoodData Central, which is a different ingestion with a different licence and its own
name-matching problem on top of the one §4 already solves.

So phase 2 is: an ingredient → FDC id mapping, a per-100g nutrient table, a quantity
normalisation path that survives "1 large onion", a servings estimate, and an honest
`nutrition_confidence`. Then §8.2's five macro-dependent diets become answerable, and
`nutrition_method` starts holding something other than null.

---

## 14. Branch and PR

Branch `claude/recipe-enrichment` off `claude/data-pipelines-bullmq-crtvmc`, and open the PR
**against that branch, not `main`** — the BullMQ pipeline this builds on is not merged yet.
