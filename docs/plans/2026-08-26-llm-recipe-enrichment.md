# 2026-08-26 — LLM recipe enrichment (second-opinion classifier)

Status: **spec — ready to implement**
Depends on: `2026-08-20-recipe-enrichment.md` (the rules pipeline this extends) — branch
`claude/llm-enrichment` is stacked on `claude/recipe-enrichment`; open the PR against that
branch, not `main`.
Related: `types.ts`'s sparse-labels invariant and `classifiers/README.md` (both are load-bearing
here), the `Label.method` per-label seam (plan §3.2 of the parent), the atproto publish gate in
`services/web/src/lib/posthog-server.ts` (the fail-closed flag idiom this copies).

> **Correction, 2026-08-27 (implementation).** Two SDK facts in this spec went stale between
> writing and building, and the code deliberately departs from the text — see `[SDK-1]` and
> `[SDK-2]` where they bite (L5, §4, §7.1, §9.2):
>
> - **`[SDK-1]` `generateObject` is deprecated; the code uses `generateText` + `Output.object`.**
>   Upstream commit `614599a` deprecated `generateObject`/`streamObject` at `ai@6.0.0-beta.127`
>   in favour of stable structured output on `generateText`, and its own doc comment says to
>   switch. Same schema, same enforcement, same thrown `NoObjectGeneratedError` carrying the
>   model's raw text, and `result.output` keeps the schema's inferred type — all four measured
>   against the mock, not assumed. There is consequently no `mode: 'json'` fallback to build:
>   `mode` does not exist on either function in this SDK major, and the strategy it used to name
>   is what `Output.object` IS.
> - **`[SDK-2]` the dependency resolved to `ai@7`, not `ai@^6`.** §4 pins `^6` and also says
>   "let pnpm resolve it; do not guess" — pnpm resolved 7.0.79. The `^6` was a guess at write
>   time, not a constraint.
>
> Implementer: log outcomes to `docs/plans/results/2026-08-26-llm-recipe-enrichment-results.md`
> (what was built, how it was verified, deliberate deviations, and — explicitly — which items
> from §12.3 were left for the human because they need live LLM or PostHog access).

> **Two constraints shape every choice below.** (1) Implementing agents have **no LLM API
> access** — nothing here may require a live Moonshot call to verify; every LLM-adjacent module
> is built against a mock and fixture JSON. (2) Implementing agents have **no PostHog access**
> beyond this document — §5 spells out every PostHog-side artifact so nobody has to go look,
> and everything the code needs from PostHog degrades to a fallback when PostHog is absent.

---

## 1. Context

The rules classifier (`services/pipeline/src/workflows/recipe-enrichment/`) is deterministic,
cheap, and honest about its limits: it emits `unknown` when the lexicon can't read a line, it
has no rule for `keto`/`paleo`/cuisine/meal-type at all, and its `may_contain` heuristics are
text patterns. An LLM can read the lines the lexicon missed, judge dimensions no rule can, and
give a second opinion on the ones rules already cover.

This plan adds a second label provider: an `llm-enrich` step that runs **after** the rules
classifier, calls Moonshot Kimi through the Vercel AI SDK, and writes labels alongside the
rules' labels under the existing per-label `method` seam. PostHog carries the whole
observability story: a feature flag gates execution, Prompt Management owns the prompt,
`$ai_generation` events carry traces/tokens/costs, and evaluations + datasets grade the output.

Same ground rules as the parent plan: nothing is ever written to `recipe.suitable_for_diet` or
published to a PDS; `not_detected` is not a safety claim; absence is a verdict only for slugs a
version actually evaluated.

### 1.1 In scope

1. Migration: LLM state columns on `recipe_enrichment`, three new `recipe_vocab` dimensions
   (`cuisine`, `meal_type`, `spice_level`), an extended verdict check constraint.
2. `llm/` module under the workflow folder: provider registry (Moonshot now; Qwen/Gemini are
   registry entries later), PostHog-managed prompt with in-code fallback, zod output schema,
   safety-asymmetric merge, `$ai_generation` capture with redaction.
3. Three new steps: `llm-enrich`, `llm-backfill`, `llm-backfill-report`, mirroring the
   existing trio.
4. A method-scoped rewrite of `writeEnrichment`'s delete, so two providers can own disjoint
   label sets in one table.
5. The PostHog-side setup checklist (§5) — flag, prompt, provider key, evaluations, dataset,
   dashboard — executed by a human/main session with MCP access, not by implementing agents.

### 1.2 Out of scope (seams only)

- Qwen and Gemini providers. The registry (§6) is the seam; only `moonshot` ships.
- Nutrition (§13 of the parent still stands). The LLM's macro-diet verdicts (§8) are
  ingredient-shape judgments, deliberately low-confidence, not nutrition math.
- Any user-facing surface for the new dimensions. The dev inspector panel shows them for free
  (labels are labels); the Randomizer reads them later.
- Prompt A/B experiments (PostHog supports them; a later exercise once evals have a baseline).
- User corrections / feedback loops on LLM labels.

---

## 2. Decisions locked

| #   | Decision                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | **Second opinion + new dimensions.** The LLM evaluates every allergen/diet slug the rules do, plus `cuisine`, `meal_type`, `spice_level`, and the six macro/paleo diets rules can't judge.                                                                                         |
| L2  | **Safety-asymmetric merge.** The LLM may escalate and may fill absence; it may never downgrade a rules `contains`/`may_contain` (allergen) or override a rules `excluded` (diet). Disagreements become PostHog events, not label writes. See §8.                                   |
| L3  | **`llm-enrich` is a step in the existing workflow**, always enqueued by `enrich` after a successful rules write; the gate lives inside the step. Not an async classifier in the `Classifier[]` array (that contract is pure/sync) and not a separate queue.                        |
| L4  | **Flag-gated, fail-closed, after every enrich.** PostHog flag `llm-enrichment-enabled` evaluated with `distinct_id = recipeId` (deterministic %-rollout over the corpus). No PostHog ⇒ no LLM call. `LLM_ENRICHMENT_ENABLED=true\|false` env override for dev.                     |
| L5  | **Vercel AI SDK, ~~`generateObject`~~ → `generateText` + `Output.object` (`[SDK-1]`), provider registry.** Moonshot Kimi via `@ai-sdk/openai-compatible` (Moonshot's API is OpenAI-compatible). Provider chosen by env; adding Qwen/Gemini is one registry entry + one dependency. |
| L6  | **Prompt lives in PostHog Prompt Management** (name `recipe-llm-enrichment`, fetched by the `production` label, cached with TTL); the same prompt text is committed in code as the fallback and the version of record for review.                                                  |
| L7  | **Manual `$ai_generation` capture via `posthog-node`**, not `@posthog/ai`'s OTel span processor. The properties object is built by a pure function agents can test; no OTel stack in the worker; no coupling to the AI SDK major that OTel support pins.                           |
| L8  | **`LLM_ENRICHMENT_VERSION`** is the LLM analogue of `CLASSIFIER_VERSION`: an int constant covering the emitted slug sets and output schema. Same absence invariant, same pin-test idiom. Prompt _wording_ changes do NOT bump it; slug/schema changes MUST.                        |
| L9  | **Label ownership is split by `method` prefix.** Rules rows are `rules@N`; LLM rows are `llm:<provider>:<model>@vN`. `writeEnrichment` deletes only rules rows (except on content change, §9.1); the LLM writer replaces only `llm:%` rows.                                        |
| L10 | **Redaction for local recipes.** `$ai_input`/`$ai_output_choices` are captured only for `origin='sync'` recipes (public network content). `origin='local'` generations keep tokens/cost/latency/model but no content. Distinct id is a service identity, never a user.             |
| L11 | **No live-call tests, anywhere.** Everything LLM-shaped is exercised through the AI SDK's mock language model and fixture JSON; everything PostHog-shaped through injected fakes. §12 is the contract.                                                                             |
| L12 | New-dimension slugs are a **closed, code-owned enum** (§7.2). The zod schema rejects anything outside it; the LLM cannot invent a cuisine, the same way D12 keeps hostile records from inventing an allergen.                                                                      |

---

## 3. Data model

One migration in `services/web/src/db/migrations/` — created with
`pnpm --filter @buttery/web db:migrate:new llm_recipe_enrichment` (never hand-name), then
`db:migrate:up` + `db:codegen`. App-owned tables stay snake_case.

### 3.1 `recipe_enrichment` — LLM state columns

```
llm_status        text             -- null | 'ok' | 'error' | 'skipped'
llm_version       int not null default 0
llm_input_hash    text
llm_model         text             -- e.g. 'moonshot:kimi-k2-0905-preview'
llm_prompt_version int             -- the PostHog prompt version actually used
llm_enriched_at   timestamptz
llm_error         text
```

`null` `llm_status` means "never attempted" — the backfill's claim signal. `'skipped'` means
the step ran and the gate said no (flag off / redaction rules / no provider configured):
recorded so a backfill doesn't re-claim it every run while the flag is off, and cheap to reset
by claiming `llm_version < current` when the flag turns on (the claim query treats `skipped`
rows as candidates whenever `force` or a version bump says so — see §9.2).

The short-circuit mirrors the rules one: skip when `llm_status='ok'` ∧
`llm_version = LLM_ENRICHMENT_VERSION` ∧ `llm_input_hash = input_hash` ∧ not `force`. Prompt
version is recorded but deliberately not part of the short-circuit (L8): iterating prompt
wording in PostHog must not silently re-run the corpus; when a prompt change is worth a
corpus re-run, that's a deliberate `llm-backfill {"force":true}`.

### 3.2 Vocabulary additions (same migration)

Three new dimensions in `recipe_vocab`, seeded like the parent plan's allergen rows (internal
`source`, **no `recipe_vocab_alias` rows** — no upstream token maps to any of these, D12
reasoning applies verbatim):

- `cuisine` — curated list, ~24 slugs: `italian`, `french`, `spanish`, `greek`, `mexican`,
  `tex_mex`, `american`, `southern_us`, `cajun_creole`, `caribbean`, `brazilian`, `peruvian`,
  `middle_eastern`, `turkish`, `north_african`, `ethiopian`, `west_african`, `indian`, `thai`,
  `vietnamese`, `chinese`, `japanese`, `korean`, `eastern_european`. (Implementer: this list is
  final for v1 — do not extend it without bumping `LLM_ENRICHMENT_VERSION`, L8/L12.)
- `meal_type` — `breakfast`, `lunch`, `dinner`, `dessert`, `snack`, `side`, `drink`.
- `spice_level` — `mild`, `medium`, `hot`.

The six macro/paleo diet slugs (`keto`, `low_carb`, `low_fat`, `low_calorie`, `diabetic`,
`paleo`) already exist in `recipe_vocab` (see `classifiers/README.md`) — no new rows.

### 3.3 Verdict check constraint

Replace the existing check on `recipe_enrichment_label` with:

```sql
check (
  (dimension = 'allergen' and verdict in ('contains','may_contain','not_detected','unknown'))
  or (dimension = 'diet'  and verdict in ('excluded','likely','unknown'))
  or (dimension in ('cuisine','meal_type','spice_level') and verdict = 'likely')
)
```

The three new dimensions are tag-shaped, not exclusion-shaped: the only stored verdict is
`likely`, `confidence` carries strength, and absence means "not this one" — sparse by the same
logic as the parent's sparse-labels note. Comment the constraint accordingly (the migration
that introduced sparse labels, `1787772317269_…`, is the style to match).

### 3.4 Sparse-labels invariant, extended

The invariant in `types.ts` gains a second version column: absence is readable as the default
only for slugs that `classifier_version` (rules sets) **or** `llm_version` (LLM sets)
actually evaluated, per the `method` on whatever row is present. Concretely:

- LLM-only slugs (`cuisine/*`, `meal_type/*`, `spice_level/*`, macro diets): absence means
  nothing unless the row's `llm_status='ok'` and `llm_version` covered that slug.
- The pin test (§12.1) snapshots the LLM emitted-slug sets against `LLM_ENRICHMENT_VERSION`
  exactly the way `classify.test.ts` pins the rules sets.

---

## 4. Where things go — code organization

The explicit goal: **a human who wants to change the prompt or the merge policy opens one
obvious file.** Everything new lives under the workflow folder:

```
services/pipeline/src/workflows/recipe-enrichment/
  llm/
    prompt.ts        ← THE PROMPT. Fallback text (template literal), PROMPT_NAME,
                        variable names, and nothing else. This file mirrors the PostHog
                        prompt; editing it is how you change the prompt without PostHog.
    prompt-fetch.ts  ← PostHog Prompt Management fetch: label 'production', in-memory
                        cache with TTL, falls back to prompt.ts on any failure.
    schema.ts        ← zod output schema, LLM emitted-slug sets (closed enums, L12),
                        LLM_ENRICHMENT_VERSION. The pin test points here.
    provider.ts      ← provider registry: env → LanguageModel. 'moonshot' today.
    classify.ts      ← orchestration: build messages (pure) → generateText → validate →
                        map to candidate Labels (pure). No DB, no queue.
    merge.ts         ← safety-asymmetric merge (pure): (rules labels, llm candidates) →
                        {writes, disagreements}. The most-tested file in this plan.
    posthog.ts       ← pipeline's posthog-node client (lazy, fail-closed gate copied from
                        services/web/src/lib/posthog-server.ts), flag check, shutdown-on-close.
    capture.ts       ← buildGenerationEvent(...) (pure: properties object + redaction)
                        and a thin send via posthog.ts. Disagreement events too.
  lib/load.ts        ← writeEnrichment gains method scoping (§9.1); new writeLlmEnrichment,
                        claimLlmBatch, markLlmError, markLlmSkipped.
  steps.ts           ← llm-enrich, llm-backfill, llm-backfill-report appended.
  types.ts           ← LlmEnrichPayload, LlmBackfillPayload; the invariant note gains §3.4's
                        second paragraph.
```

`@buttery/pipeline-contract` gains `LLM_ENRICH_STEP`, `LLM_BACKFILL_STEP`,
`LLM_BACKFILL_REPORT_STEP`, `LlmEnrichPayload`, and `llmEnrichJobId(recipeId)` (same
`_`-separator reasoning as `enrichJobId` — read its doc comment before touching it).

New dependencies (`services/pipeline/package.json`): `ai`, `@ai-sdk/openai-compatible`, `zod`,
`posthog-node`. Pin `ai@^6` `[SDK-2: resolved to ai@7]` with the matching
`@ai-sdk/openai-compatible` major (let pnpm
resolve it; do not guess). The pipeline runs under Node's native TS type-stripping
(`node src/server.ts`) — the same dependency rules as `atproto-cron-sync` apply: real ESM
files, explicit subpath imports, no bundler-only packages. All four of these ship real ESM;
verify with `pnpm --filter @buttery/pipeline typecheck && node --check`-level smoke, and
`run:once` boots without importing any of them eagerly (everything LLM is lazily imported
inside the step, mirroring how web treats `pg`).

---

## 5. PostHog features — the part implementing agents cannot do

Everything in this section is created **in PostHog** (project "Buttery", id 538428,
us.posthog.com) by Daniel or a main-session agent with MCP access. Implementing agents: treat
these as existing-by-the-time-it-matters; code must behave correctly when they are absent
(fallbacks, fail-closed). The exact names below are contractual — code references them.

### 5.1 Feature flag (gate)

- Key: **`llm-enrichment-enabled`**, boolean, created at **0% rollout**.
- Evaluated server-side from the pipeline with `distinct_id = recipeId` (L4), so a 10%
  rollout deterministically selects 10% of recipes — a corpus canary, not a user gate.
- Fail-closed exactly like `ATPROTO_PUBLISH_FLAG`: flag false/undefined/unreachable/no client
  ⇒ skip. Note: evaluating a flag captures a `$feature_flag_called` event per evaluation;
  that is fine at recipe-job volume but is why the env override short-circuits _before_ the
  flag check.

### 5.2 Prompt Management

- Prompt name: **`recipe-llm-enrichment`** (names are immutable; letters/numbers/hyphens/
  underscores only). Label **`production`** points at the released version; saving ≠ releasing.
- Content: seeded verbatim from `llm/prompt.ts` (§6.3). Iterating in the PostHog UI and
  moving the `production` label is the rapid-update path; the code fallback is the safety net
  and the reviewable copy. **Convention: when a PostHog prompt iteration settles, copy it back
  into `prompt.ts` in the next PR** so code review sees prompt history — PostHog is the fast
  path, git is the record.
- Variables use `{{name}}` syntax; the SDK compiles them. This plan uses `{{recipe_json}}`
  only (§6.3) — model params stay in code, not in the prompt's `config`, so behavior changes
  ride deploys.
- Runtime fetch (§6.2) needs a **personal API key with `llm_prompt:read` scope** in the
  pipeline env (`POSTHOG_PERSONAL_API_KEY`) plus `POSTHOG_PROJECT_ID=538428` — the prompts
  API authenticates with a personal key against the app host (`https://us.posthog.com`),
  unlike event capture which uses the project token against the ingestion host.

### 5.3 AI observability (arrives with the events — nothing to pre-create)

`$ai_generation` events from §10 light up the Traces/Generations tabs automatically. Two
setup items anyway:

- **Cost tracking**: PostHog prices known models from `$ai_model` + token counts. Kimi model
  ids may not be in its price table — check the first real generations; if
  `$ai_total_cost_usd` is missing, set `LLM_INPUT_TOKEN_PRICE_USD`/`LLM_OUTPUT_TOKEN_PRICE_USD`
  env vars (§11) and the capture helper sends `$ai_input_token_price`/`$ai_output_token_price`
  so PostHog computes costs itself.
- **Dashboard** "LLM enrichment": generations/day, error rate (`$ai_is_error`), p50/p95
  `$ai_latency`, total cost/day, disagreement-event count by dimension, skip reasons. Built
  from the captured events after first rollout; not a code deliverable.

### 5.4 Evaluations (online, on live traffic)

Created via MCP (`llma-evaluation-create`) once events flow. All target `generation`,
condition-filtered to `ai_feature = 'recipe-llm-enrichment'` (a custom property §10 always
sends), sampled via `rollout_percentage` to control judge cost:

1. **`llm-output-schema-valid`** — `hog` evaluation (deterministic, free): parses the
   generation's output JSON, returns false on schema violations. Catches drift the zod layer
   already rejects in-process — this is the PostHog-side mirror that makes rejects _visible_.
2. **`allergen-escalation-sane`** — `llm_judge`, boolean with N/A allowed, ~20% sample:
   "Given the ingredient lines in the input, is each allergen the output marks
   contains/may_contain plausibly supported by a specific line? Fail if any escalation has no
   plausible ingredient basis." Runs only on `origin='sync'` generations (local ones are
   redacted, L10 — the condition filters on the `recipe_origin` property).
3. **`cuisine-meal-type-sane`** — `llm_judge`, boolean, ~10% sample: "Do the cuisine and
   meal_type labels plausibly match the recipe name and ingredients? N/A if the output emitted
   none."

- LLM-judge evaluations need a **provider key configured in PostHog** (Settings → LLM
  analytics provider keys). Use a Gemini or OpenAI key; this is PostHog-side spend, separate
  from Moonshot.

Results are `$ai_evaluation` events — they join the dashboard and, over time, decide whether
the safety-asymmetric policy can be loosened.

### 5.5 Dataset (offline goldens)

- Dataset **`recipe-llm-enrichment-goldens`** (`llma-dataset-create`), seeded from the
  parent plan's tricky-recipe list (fish-sauce "vegetarian" curry, Worcestershire, marzipan,
  oyster sauce, …) plus early disagreement events worth keeping.
- Each item: input = the same recipe JSON the prompt receives; expected output = hand-agreed
  labels. Used with evaluation reports (`llma-evaluation-report-*`) to grade a prompt change
  against the goldens _before_ moving the `production` label — that is the whole
  edit-prompt-in-PostHog loop: edit → report against goldens → move label → watch online evals.

### 5.6 Ops checklist (in order)

1. Create flag `llm-enrichment-enabled` at 0%.
2. Create prompt `recipe-llm-enrichment` from `llm/prompt.ts`; set `production` label.
3. Mint personal API key (`llm_prompt:read`); set pipeline env vars (§11) via
   `.railway/railway.ts` → `railway config plan` → `apply`.
4. Deploy; run one recipe with `LLM_ENRICHMENT_ENABLED=true` override; verify the generation
   in PostHog and the labels in the dev panel.
5. Configure judge provider key; create the three evaluations (paused → enabled).
6. Flag to 5–10%; watch dashboard + evals; ratchet.
7. Seed the goldens dataset.

---

## 6. Provider layer and prompt

### 6.1 `llm/provider.ts`

```ts
// Registry keyed by LLM_ENRICHMENT_PROVIDER. Each entry: (env) => LanguageModel.
// 'moonshot': createOpenAICompatible({ name: 'moonshot', baseURL: env.MOONSHOT_BASE_URL
//   ?? 'https://api.moonshot.ai/v1', apiKey: env.MOONSHOT_API_KEY })
//   .chatModel(env.LLM_ENRICHMENT_MODEL)
```

Model id comes from `LLM_ENRICHMENT_MODEL` (no default baked into code — Moonshot renames
models; a wrong hardcoded id is a runtime error someone reads at deploy, not a constant to
maintain). The `$ai_provider`/`$ai_model` capture fields come from the same env values.
Adding Qwen later = one `case "qwen"` (also OpenAI-compatible, DashScope baseURL); Gemini =
`@ai-sdk/google` dependency + one case. Nothing else in the folder knows which provider runs.

### 6.2 `llm/prompt-fetch.ts`

- Try `posthog-node`'s Prompts client (`import { Prompts } from "posthog-node"` — verify the
  export against the installed version; it is documented but recent):
  `prompts.get('recipe-llm-enrichment', { label: 'production', cacheTtlSeconds: 300, fallback: FALLBACK_PROMPT })`,
  host `https://us.posthog.com`, personal API key + project API key from env.
- If the export is absent in the installed `posthog-node`, implement the same contract over
  REST: `GET /api/projects/${POSTHOG_PROJECT_ID}/llm_prompts/resolve/name/recipe-llm-enrichment/?label=production`
  with `Authorization: Bearer ${POSTHOG_PERSONAL_API_KEY}`, 5-minute in-memory cache,
  fallback on any non-200/timeout (2s budget — a prompt fetch must never be the slow part).
- Returns `{ text, version: number | null }` — `version: null` means fallback was used, and
  is recorded in `llm_prompt_version` as null so "which recipes ran on the fallback" is a
  query, not a mystery.
- Unit tests inject a fake fetcher; the fallback path is the tested-by-default path (L11).

### 6.3 The prompt (`llm/prompt.ts` — the file a human edits)

One system prompt, one `{{recipe_json}}` variable. Structure (write the real thing in the
file, this is the outline):

- Role: food-classification assistant for a recipe app; you receive one recipe as JSON
  (name, ingredient lines with ordinals, the rules classifier's own labels for context).
- Task: emit judgments for exactly the listed slugs (the enums are restated in the prompt
  AND enforced by schema); cite the ordinal(s) that justify each non-default judgment.
- Explicit cautions: `not_detected` semantics; when unsure between not_detected and
  may_contain for an allergen, prefer may_contain; macro-diet verdicts are ingredient-shape
  guesses — say `likely` only for clear cases and keep confidence ≤ 0.6; never invent slugs.
- Output: JSON only, matching the schema (§7.1), no prose.

The rules labels are included as context deliberately — the model should explain
disagreement, not discover everything cold; evidence quality is what the judge evals grade.

---

## 7. Output schema and versioning

### 7.1 `llm/schema.ts` — zod

```ts
{
  allergens: [{ slug: AllergenSlug, verdict: 'contains'|'may_contain'|'not_detected',
                confidence: 0..1, ordinals: number[], note?: string }],
  diets:     [{ slug: LlmDietSlug, verdict: 'excluded'|'likely',
                confidence: 0..1, ordinals: number[], note?: string }],
  cuisine:   [{ slug: CuisineSlug, confidence: 0..1 }],          // ≤ 2 entries
  mealType:  [{ slug: MealTypeSlug, confidence: 0..1 }],         // ≤ 2 entries
  spiceLevel:{ slug: 'mild'|'medium'|'hot', confidence: 0..1 } | null,
}
```

- `LlmDietSlug` = the rules' seven emitted diet slugs + the six macro/paleo slugs.
- Sparse on the wire too: the model emits only non-default judgments (no `not_detected`
  spam); an omitted allergen slug means the model found nothing (mapped per §8).
- All slug fields are `z.enum` over the closed sets (L12). `generateObject` with this schema;
  on provider JSON-mode quirks fall back to `generateObject({ mode: 'json' })` — decide by
  what the mock tests can express, not by live behavior. **`[SDK-1]`** — both sentences are
  superseded: the call is `generateText({ output: Output.object({ schema }) })`, and there is
  no `mode` on either function in `ai@7` to fall back to.
- A zod-rejected response is an error (`llm_status='error'`, `$ai_is_error` capture with the
  raw text in `$ai_error`) and retries per job options — Kimi occasionally drooling invalid
  JSON is an expected failure mode, and retry-then-error is honest.

### 7.2 `LLM_ENRICHMENT_VERSION`

Starts at 1. Bump whenever any emitted slug set or the schema shape changes (L8). Pin test:
snapshot of `{version, allergenSlugs, dietSlugs, cuisineSlugs, mealTypeSlugs, spiceLevels}`
in `llm/schema.test.ts`, same custom-failure-message idiom as `classify.test.ts` — read that
file first and copy its shape.

---

## 8. Merge policy — `llm/merge.ts` (pure)

Input: the rules labels just written for this recipe, the validated LLM output. Output:
`{ writes: Label[], disagreements: Disagreement[] }`. No I/O, exhaustively tested.

| Dimension                                    | Rules row present?              | LLM says               | Result                                                                       |
| -------------------------------------------- | ------------------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| allergen                                     | none (absence = not_detected)   | contains / may_contain | **write** LLM row (escalation)                                               |
| allergen                                     | none                            | not_detected / omitted | nothing                                                                      |
| allergen                                     | `unknown` (rules couldn't read) | contains / may_contain | **write** LLM row, replacing the rules `unknown` row                         |
| allergen                                     | `unknown`                       | not_detected           | **write** LLM row `not_detected` (resolves unknown; row keeps `method: llm`) |
| allergen                                     | `contains` / `may_contain`      | anything weaker        | rules row stands; **disagreement event**                                     |
| allergen                                     | `may_contain`                   | `contains`             | **write** LLM row (escalation)                                               |
| diet                                         | `excluded`                      | anything               | rules row stands; disagreement event if LLM says likely                      |
| diet                                         | `likely` / `unknown`            | excluded               | **write** LLM row (exclusion is the safe direction)                          |
| diet                                         | `likely` / `unknown` / none     | likely                 | **write** LLM row only where rules had `unknown` or nothing                  |
| macro diets, cuisine, meal_type, spice_level | never (rules don't emit)        | any                    | **write** LLM rows (LLM-owned dimensions)                                    |

Notes: an allergen `not_detected` LLM row IS stored (unlike rules' sparse absence) only in
the resolves-unknown case — it is the one place a stored `not_detected` says something
absence doesn't ("a model read the lines the rules couldn't"). `evidence` on every LLM row:
`rule: 'llm'`, the cited ordinals resolved to `EvidenceLine`s, the model's note, and — on
replacement rows — a note naming the rules verdict it replaced. `method` string:
`llm:${provider}:${model}@v${LLM_ENRICHMENT_VERSION}`.

`Disagreement` = `{dimension, slug, rulesVerdict, llmVerdict, llmConfidence}` — captured as a
`llm_enrichment_disagreement` event (no ingredient text; recipeId + origin only), the raw
feed for §5.4's evals and §5.5's dataset triage.

---

## 9. Workflow steps

### 9.1 `writeEnrichment` becomes method-scoped (the one behavioral change to existing code)

- Rules path deletes `where recipe_id = $1 and method not like 'llm:%'` — **except** when the
  content fingerprint changed from the stored `input_hash`, in which case delete everything:
  LLM labels derived from ingredients that no longer exist are stale evidence, and the
  re-enqueued `llm-enrich` will rebuild them. (Pass a `contentChanged: boolean` down from the
  step, which already computed both hashes.)
- New `writeLlmEnrichment(pool, recipeId, …)`: one transaction — delete `method like 'llm:%'`
  rows, insert the merge's writes, update the `llm_*` columns to `ok`. Same
  outside-the-transaction error checkpoint idiom as `enrich` (`markLlmError`).
- The existing `load.db.test.ts` suite grows cases for both scopings and for the
  cascade-on-content-change.

### 9.2 The steps (mirror the existing trio; read `steps.ts` end to end first)

- **`llm-enrich`** (payload `{recipeId, force?}`, job id `llmEnrichJobId(recipeId)`,
  `attempts: 3`, exponential backoff from 10s — LLM providers rate-limit; same removeOn*
  counts as `enrich`):
  1. Env override check (`LLM_ENRICHMENT_ENABLED`): `"false"` ⇒ mark `skipped`, done;
     `"true"` ⇒ bypass flag.
  2. Flag `llm-enrichment-enabled` via `llm/posthog.ts`, distinct id = recipeId, fail-closed
     ⇒ mark `skipped` (reason in a `llm_error`-style note? no — `skipped` + log line; the
     column stays for real errors).
  3. Load recipe + rules labels; require `recipe_enrichment.status='ok'` and rules
     `input_hash` = current content fingerprint (rules run first, always — if stale, mark
     `skipped`; the next `enrich` re-enqueues us).
  4. Short-circuit per §3.1.
  5. Fetch prompt (§6.2), build messages (pure), `generateText` `[SDK-1]` with
     `abortSignal: AbortSignal.timeout(60_000)` and `maxOutputTokens` sized to the schema.
  6. Merge (§8) → `writeLlmEnrichment`.
  7. Capture `$ai_generation` (§10) and one `llm_enrichment_disagreement` per disagreement.
     Capture is fire-and-forget and never fails the job.
- **`enrich` change**: after a successful `writeEnrichment`, enqueue `llm-enrich` for the
  same recipe (same queue — plain `flow`-less add via the step's own queue access, or
  `ctx.enqueue` with this workflow's own name; pick whichever `define.ts` makes honest in
  `consoleHost` too, and keep it best-effort: a failed enqueue costs freshness, the backfill
  finds it). Pass `force` through.
- **`llm-backfill`** (payload `{limit?, force?, localOnly?}`, defaults/caps as the existing
  backfill): claims recipes where `status='ok'` and (`llm_status is null` or
  `llm_status='error'` or `llm_version < current` or (`force` and anything, including
  `skipped` and `ok`)); same local-first ordering; fans out `llm-enrich` children under
  **`llm-backfill-report`** (same fold-and-log shape). Reached via
  `POST /jobs/recipe-enrichment {"name":"llm-backfill"}`. No schedule (D15 stands).
- `defineWorkflow`'s `defaultJobOptions` already covers hand-posted jobs; do not repeat that
  mistake-insurance story, it's written in `index.ts`.

Concurrency: the existing `RECIPE_ENRICHMENT_MAX_IN_FLIGHT` (16) now also bounds concurrent
LLM calls, which doubles as the Moonshot rate-limit guard. If enrich-vs-llm contention ever
matters, that's a later dedicated-queue change; note it in the module doc, don't build it.

---

## 10. Observability capture — `llm/capture.ts`

Manual `$ai_generation` via `posthog-node` (L7). `buildGenerationEvent(input)` is pure and
returns `{distinctId, event, properties}`; a thin `send` hands it to the client.

- `distinctId`: **`recipe-enrichment-pipeline`** — a service identity. Never a user DID
  (L10): recipe content must not attach to a person.
- Properties: `$ai_trace_id` (`crypto.randomUUID()` per llm-enrich run), `$ai_span_name:
'classify-recipe'`, `$ai_model`, `$ai_provider`, `$ai_input_tokens`/`$ai_output_tokens`
  (from `result.usage`), `$ai_latency` (seconds), `$ai_http_status`, `$ai_base_url`, and on
  failure `$ai_is_error: true` + `$ai_error`.
- Content: `$ai_input` (messages array) and `$ai_output_choices` **only when
  `origin='sync'`**; for `origin='local'` both are omitted entirely (L10).
- Custom properties (these are what flags, evals, and dashboards filter on):
  `ai_feature: 'recipe-llm-enrichment'`, `recipe_id`, `recipe_origin`, `prompt_name`,
  `prompt_version` (null = fallback), `llm_version`, `labels_written`, `disagreements`,
  `line_count`, `unresolved_line_count`.
- If PostHog is absent (gate off), capture is a no-op — the LLM result is still written to
  the DB; observability is never load-bearing.
- Custom pricing passthrough per §5.3 when the env vars are set.
- `llm/posthog.ts` copies `posthog-server.ts`'s shape: `POSTHOG_ENABLED === "true"` allowlist,
  lazy client, `flushAt: 1`, and a `shutdown()` wired into the workflow's `close` alongside
  `closeDb` so a draining replica flushes and exits.

---

## 11. Config and infra

`services/pipeline/.env.example`, all commented:

```
LLM_ENRICHMENT_ENABLED=      # true|false override; unset = defer to PostHog flag (fail closed)
LLM_ENRICHMENT_PROVIDER=moonshot
LLM_ENRICHMENT_MODEL=        # e.g. kimi-k2-0905-preview — verify against platform.moonshot.ai
MOONSHOT_API_KEY=
MOONSHOT_BASE_URL=           # default https://api.moonshot.ai/v1
POSTHOG_ENABLED=             # allowlist gate, same semantics as web
POSTHOG_PROJECT_TOKEN=       # event capture (ingestion host)
POSTHOG_HOST=                # default https://us.i.posthog.com
POSTHOG_PERSONAL_API_KEY=    # llm_prompt:read — prompt fetch only
POSTHOG_PROJECT_ID=          # 538428
LLM_INPUT_TOKEN_PRICE_USD=   # only if PostHog can't price the model (§5.3)
LLM_OUTPUT_TOKEN_PRICE_USD=
```

`.railway/railway.ts`: add the same set to `pipeline` and `pipelineWorker` (PostHog vars can
reference the existing shared PostHog config the web service uses — see the file's existing
posthog-node comment). `railway config plan` → `apply`; never the dashboard. Secrets
(`MOONSHOT_API_KEY`, `POSTHOG_PERSONAL_API_KEY`) are set by a human, not committed.

`AGENTS.md`: one line under Workflow Rules — llm-enrich exists, is flag-gated fail-closed,
and the prompt's source of truth story (PostHog fast path, `llm/prompt.ts` record). Match the
file's voice; it cuts UI conventions, keep it to the non-obvious.

---

## 12. Testing under the blind constraint

### 12.1 What agents CAN verify (and must)

- `llm/merge.test.ts` — every row of §8's table, plus: LLM tries to downgrade fish-sauce
  `contains` (rules row stands, disagreement emitted); LLM resolves `unknown` both directions;
  cuisine capped at 2; confidence clamping.
- `llm/schema.test.ts` — fixture JSON: valid full output, unknown cuisine slug (reject),
  out-of-range confidence (reject), prose-wrapped JSON (reject), plus the version pin test
  (§7.2).
- `llm/classify.test.ts` — AI SDK mock language model (exported from `ai/test`; use whatever
  mock the installed major ships — check `node_modules/ai`'s types, do not guess from docs)
  returning fixture outputs: happy path end-to-end to Labels; invalid JSON → thrown; timeout →
  thrown.
- `llm/capture.test.ts` — `buildGenerationEvent`: sync recipe carries `$ai_input`; local
  recipe carries neither content field but keeps tokens/costs; error shape; custom props.
- `llm/prompt-fetch.test.ts` — injected fetcher: cache TTL honored, fallback on failure,
  `version: null` on fallback.
- `load.db.test.ts` additions (§9.1) and a `steps` test for skip-marking via the env
  override — `llm-enrich` with `LLM_ENRICHMENT_ENABLED=false` writes `skipped` and never
  constructs a provider.
- `pnpm --filter @buttery/pipeline test && typecheck`, `pnpm --filter @buttery/web typecheck`
  (codegen types), `pnpm lint`.

### 12.2 What agents must NOT attempt

No live Moonshot calls, no live PostHog calls, no "let's just try the API key" — the keys
aren't there. Do not stub a fake success and call it verified; the results file lists §12.3
as unverified-by-agent, plainly.

### 12.3 Human verification (post-implementation, with keys)

1. Local stack + `LLM_ENRICHMENT_ENABLED=true` + real `MOONSHOT_API_KEY`: save the fish-sauce
   pad thai; watch `llm-enrich` on the Bull Board; dev panel shows `llm:` labels alongside
   `rules@2`, cuisine/meal_type/spice rows present.
2. `$ai_generation` visible in PostHog Traces/Generations with tokens and (eventually) cost;
   a local-origin recipe's generation shows no input/output content.
3. Flag path: unset the override, `POSTHOG_ENABLED=true` against prod flag at 0% → `skipped`;
   at 100% → runs.
4. `POST /jobs/recipe-enrichment {"name":"llm-backfill","data":{"limit":20}}` → fan-out,
   report, `remaining` sane.
5. §5.6's checklist through evals + dataset.

---

## 13. Results file

`docs/plans/results/2026-08-26-llm-recipe-enrichment-results.md`: what was built, deviations,
the §12.1 suite outcomes, the explicit §12.3 unverified list, and — once the human runs the
canary — first-week numbers worth recording: generations/day, cost/day, schema-reject rate,
disagreement rate by dimension. Those four numbers decide whether the safety-asymmetric
policy loosens, the flag ratchets, or the prompt goes back to the shop.
