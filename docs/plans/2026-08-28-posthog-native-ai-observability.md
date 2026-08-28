# Move `@ai/` PostHog instrumentation from hand-rolled `$ai_generation` to PostHog's native OTel path

## Context you are given (verified — do not re-litigate)

The pipeline (`services/pipeline`) hand-builds `$ai_generation` events and fires them
through `posthog-node`. `src/queues/recipe-enrichment/lib/capture.ts` carries a long
doc comment justifying this over `@posthog/ai`, on the grounds that `@posthog/ai`
"pins its own OTel dependency stack". **That justification is factually wrong, and the
conclusion it supports is also wrong, but not for the reason the comment gives.** Here
is what was actually measured in the repo:

1. `@posthog/ai@8.8.1` is **already a dependency** of `services/pipeline`
   (used for `Prompts` in `src/plugins/posthog.ts`).
2. `@posthog/ai/vercel`'s `withTracing` is a plain model wrapper with **no OTel
   runtime dependency at all** — `dist/vercel/index.mjs` imports only `uuid` and
   `@posthog/core`. So the comment's premise is false.
3. **However**, `withTracing` hard-throws on this stack:
   ```js
   if (specificationVersion !== "v2" && specificationVersion !== "v3") {
     throw new Error(`[PostHog AI] withTracing supports Vercel AI SDK v5 and v6 models only. ` + `Use @ai-sdk/otel with @posthog/ai/otel for AI SDK v7 models.`);
   }
   ```
   Verified at runtime from `services/pipeline`: `createOpenAICompatible(...).chatModel('m')`
   under `ai@7.0.79` / `@ai-sdk/openai-compatible@3.0.37` reports
   `specificationVersion: 'v4'`. So `withTracing` is **not** an option here.
4. PostHog's own docs agree: <https://posthog.com/docs/ai-observability/installation/vercel-ai>
   — "This OpenTelemetry integration is the supported path for Vercel AI SDK v7. The
   legacy PostHog `withTracing` wrapper supports the v5 and v6 provider interfaces and
   rejects v7 models."

**Therefore: the task is to adopt `@posthog/ai/otel`'s `PostHogSpanProcessor` +
`@ai-sdk/otel`'s `OpenTelemetry` telemetry integration, and delete the hand-rolled
`$ai_generation` machinery.** The user has explicitly approved wiring up OTel for this.

Do not spend time re-evaluating `withTracing`. Do not spend time arguing for keeping
the manual path. Both questions are settled above.

## Repo orientation

Working dir: `/Users/dcousineau/Projects/personal/buttery`, branch `claude/llm-enrichment`.
Package manager `pnpm` (v11), Node ^26, TypeScript ^7, `node --watch src/server.ts` runs
TS directly (Node-native TS — no bundler). Tests are `vitest`.

Files that matter:

| Path                                                                  | Role                                                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `services/pipeline/src/queues/recipe-enrichment/index.ts`             | `runLlmEnrich` — the single `generateText` call site (~line 193-265)                                               |
| `services/pipeline/src/queues/recipe-enrichment/lib/capture.ts`       | 481 lines. Hand-built `$ai_generation` + the `llm_enrichment_disagreement` event                                   |
| `services/pipeline/src/queues/recipe-enrichment/lib/capture.test.ts`  | 300 lines, tests the above                                                                                         |
| `services/pipeline/src/lib/ai/capture.ts`                             | A generic **copy** of the same `$ai_generation` builder, wired into `plugins/ai.ts`                                |
| `services/pipeline/src/lib/ai/provider.ts`                            | `resolveProvider()` — env → `LanguageModel` registry (moonshot/Kimi over `@ai-sdk/openai-compatible`)              |
| `services/pipeline/src/plugins/ai.ts`                                 | Decorates `fastify.ai` = `{ resolveProvider, captureGeneration, modelRawText }`                                    |
| `services/pipeline/src/plugins/posthog.ts`                            | Decorates `fastify.posthog` = `{ client, fetchPrompt }`; owns the `posthog-node` client and its `onClose` shutdown |
| `services/pipeline/src/plugins/env.ts`                                | zod env schema (`POSTHOG_*`, `LLM_*`)                                                                              |
| `services/pipeline/src/server.ts`, `src/worker.ts`                    | The two entrypoints; both call `buildApp()` from `src/app.ts`                                                      |
| `services/pipeline/src/queues/recipe-enrichment/index.llm.db.test.ts` | Integration test against a real DB                                                                                 |
| `services/pipeline/.env.example`                                      | Documents every env var, including the pricing ones                                                                |

## What to build

### 1. Dependencies

Add to `services/pipeline`:

```
pnpm --filter @buttery/pipeline add ai@^7.0.83 @ai-sdk/otel@^1.0.83 @opentelemetry/api@^1.9.1 \
  @opentelemetry/sdk-node @opentelemetry/resources @opentelemetry/sdk-trace-base \
  @opentelemetry/exporter-trace-otlp-http
```

Notes:

- The `ai` bump from `^7.0.79` to `^7.0.83` is **required**: `@ai-sdk/otel@1.0.83`
  depends on `ai@7.0.83` _exactly_. Without the bump pnpm installs a second copy of
  `ai`, and `registerTelemetry`'s global registry is a module singleton — two copies
  means the integration you register is not the one `generateText` consults.
  Verify with `pnpm why ai` that exactly one `ai` version resolves for the pipeline.
- `@opentelemetry/sdk-trace-base`, `@opentelemetry/exporter-trace-otlp-http` and
  `@opentelemetry/api` are declared peers of `@posthog/ai`; make them direct deps so
  the peer resolution is explicit rather than hoisted luck.

### 2. Telemetry bootstrap

Create `services/pipeline/src/lib/ai/telemetry.ts` (or `src/telemetry.ts` — your call,
but keep it out of `src/plugins/` if it must run before Fastify boots).

It must:

- Read `POSTHOG_ENABLED`, `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST` and be a **total
  no-op** when PostHog is disabled or unconfigured. This is the existing convention
  everywhere in this codebase (`plugins/posthog.ts` returns a `null` client rather
  than throwing) — match it. Do not start a `NodeSDK` in dev/test.
- Construct `new PostHogSpanProcessor({ projectToken, host })` from `@posthog/ai/otel`,
  feed it to `new NodeSDK({ resource: resourceFromAttributes({ 'service.name': ... }), spanProcessors: [processor] })`,
  call `sdk.start()`, and call `registerTelemetry(new OpenTelemetry({ enrichSpan }))`
  from `ai` + `@ai-sdk/otel`.
- Export the processor (or a `flush()`/`shutdown()` pair) so it can be flushed on
  graceful shutdown. The `NodeSDK`/`PostHogSpanProcessor` batches; a Railway worker
  replica that is scaled down mid-drain must flush or the last jobs' generations are
  lost. Note that `services/pipeline/src/worker.ts` already has a `SIGTERM`/`SIGINT`
  drain that calls `app.close()`, and `plugins/posthog.ts` already has an `onClose`
  hook that shuts the `posthog-node` client down — hang the `forceFlush()` there so
  there is exactly one shutdown path, not two.
- Be imported **before the first AI SDK call**. Both `src/server.ts` and `src/worker.ts`
  are entrypoints; the worker is the one that actually runs `runLlmEnrich`. Prefer a
  single import at the very top of each entrypoint over `node --import`, because the
  `start`/`dev` scripts in `services/pipeline/package.json` are plain
  `node src/worker.ts` and adding a loader flag means touching Railway start commands
  and `process-compose` config too. If you do choose `--import`, update every place
  that launches these processes.

### 3. Per-call metadata at the `generateText` site

`runLlmEnrich` in `src/queues/recipe-enrichment/index.ts` currently passes nothing to
`generateText`'s telemetry. It must now carry, per job:

- `$ai_trace_id` — the existing `traceId` (`crypto.randomUUID()` at the top of the step)
- the distinct id — currently `PIPELINE_DISTINCT_ID = "recipe-enrichment-pipeline"`,
  a **service** identity. Read that constant's doc comment in `capture.ts` before you
  touch it: recipe content must never be attributable to a person via distinct id.
  Preserve that property. On the OTel path the docs say the attribute is
  `posthog.distinct_id`.
- `$ai_span_name` (currently `"classify-recipe"`), `$ai_prompt_name`, `$ai_prompt_version`
- the plain-named duplicates `prompt_name` / `prompt_version` — `capture.ts`'s comment
  says human-built dashboards and PostHog evaluations already filter on the unprefixed
  spellings, so dropping them silently breaks those. Keep both.
- `ai_feature: "recipe-llm-enrichment"` — contractual, evaluations filter on it
- `recipe_id`, `recipe_origin`, `llm_version`, `labels_written`, `disagreements`,
  `line_count`, `unresolved_line_count`

**Two ways to get these onto the span. Pick one and say why in the commit message:**

- **(a) `runtimeContext` + `telemetry.includeRuntimeContext` + a global `enrichSpan`.**
  This is what PostHog's docs show. `enrichSpan` receives
  `{ spanType, operationId, callId, runtimeContext }` and returns an OTel `Attributes`
  object. Runtime-context keys are excluded unless explicitly `true` in
  `includeRuntimeContext`. Caveat from the docs: `@ai-sdk/otel` passes `runtimeContext`
  to `enrichSpan` for `generateText`/`streamText` but _not_ for object generation,
  embeddings or reranking. This call site uses `generateText` with `Output.object(...)`,
  not `generateObject`, so it should be on the supported side — **verify this
  empirically, do not assume.**
- **(b) `telemetry.integrations: [new OpenTelemetry({ enrichSpan })]` per call.**
  `TelemetryOptions.integrations` is documented as "Per-call telemetry integrations
  ... take precedence over the globally registered integrations for this call". This
  lets the `enrichSpan` closure capture the job's properties directly, sidestepping
  the `runtimeContext` round-trip and its object-generation caveat entirely. Likely
  cleaner for a one-generation-per-job worker. Still needs the `NodeSDK` +
  `PostHogSpanProcessor` from step 2 — only the registration changes.

**Ordering problem to solve either way:** `labels_written`, `disagreements`,
`line_count` and `unresolved_line_count` describe the _merge output_, which only
exists after `generateText` returns and `mergeLlmLabels` has run. `enrichSpan` fires
when the span is **created**, so those values are not available to it. Options:
attach only the pre-call properties to the generation span and emit the merge
outcome as its own event; or restructure so the merge counts ride a separate
`llm_enrichment_*` event keyed by the same `$ai_trace_id`. Decide, and record the
choice in the decision journal (see "Journal" below). Do not silently drop them.

### 4. Privacy / redaction — this is load-bearing, read it twice

`buildGenerationEvent` in `capture.ts` attaches `$ai_input` and `$ai_output_choices`
**only when `recipeOrigin === 'sync'`**. For `'local'` recipes the keys are omitted
entirely — the doc comment explains why (a synced recipe is public web content; a
local one is somebody's own hand-typed, possibly personal, data) and the test asserts
`expect(props).not.toHaveProperty(...)` precisely because that is the only assertion
that proves nothing leaked.

On the OTel path the control is `telemetry.recordInputs` / `telemetry.recordOutputs`
(booleans, per call, default `true`). Wire them to
`recordInputs: recipeOrigin === 'sync'`, same for `recordOutputs`. **Then prove it**:
add a test that runs a `local`-origin generation against a fake/recording span
exporter and asserts no prompt or output text appears in any exported span attribute.
"The flag is set" is not proof; "nothing leaked" is.

### 5. Pricing overrides — open question, resolve it

`LLM_INPUT_TOKEN_PRICE_USD` / `LLM_OUTPUT_TOKEN_PRICE_USD` (in `.env.example`,
`plugins/env.ts`, `.railway/railway.ts`, and `docs/plans/2026-08-26-llm-recipe-enrichment.md`)
currently become `$ai_input_token_price` / `$ai_output_token_price` on the event. They
exist because PostHog may not have Kimi in its price table.

The OTel path has no documented cost-override hook, and `enrichSpan` cannot compute a
total cost anyway (it fires at span creation, before token counts exist). But the unit
prices are env constants, so emitting `$ai_input_token_price` / `$ai_output_token_price`
as span attributes from `enrichSpan` is at least _possible_. **What is not known is
whether PostHog's OTLP ingestion honours those attributes the way `posthog-node`
capture does.** Determine this — check `$ai_generation` events actually landing in the
project (`us.posthog.com`, project "Buttery", id 538428), or PostHog's generations
docs, or ask PostHog. Then either:

- keep the env vars and emit the attributes (if honoured), or
- delete the env vars from all five places above and note in the commit message that
  PostHog server-side pricing is now the only source, or
- if Kimi genuinely is unpriced and OTLP won't take the override, say so plainly and
  leave a `blocked` journal entry rather than shipping silently-wrong cost data.

### 6. Failure semantics — behaviour change, handle deliberately

Today `captureGenerationFailure` emits an `$ai_generation` with `$ai_is_error`,
`httpStatus: 0`, zero tokens, for **any** throw out of the `try` block — including
`NoObjectGeneratedError`, the AI SDK's schema-validation rejection.

On the native path that splits in two, and the split is more accurate:

- **Transport/provider failures** (timeout via `AbortSignal.timeout`, network, 4xx/5xx)
  happen inside `doGenerate`, so the AI SDK's own error span carries them and PostHog
  gets a proper errored generation for free. Delete the manual equivalent.
- **Schema rejection** happens _above_ the model layer: `doGenerate` succeeded, tokens
  were spent, and `generateText` then failed to parse the output against
  `llmOutputSchema`. The generation span will record a **success**. That is truthful —
  but the existing `$ai_is_error` signal disappears, which will change any dashboard
  or evaluation built on it.

Preserve the signal without double-counting the generation: emit a separate
domain event (e.g. `llm_enrichment_failed`) carrying the same `$ai_trace_id`, the
error message, and `modelRawText(err)`'s raw model text. `fastify.ai.modelRawText`
(`src/lib/ai/errors.ts`) already extracts that. Do **not** emit a second
`$ai_generation`.

### 7. Deletions

Once the above works, delete rather than deprecate — this repo's convention is that
tests serve the implementation, not the reverse, and obsolete tests get deleted:

- `services/pipeline/src/lib/ai/capture.ts` — entirely (generic `$ai_generation` builder)
- `plugins/ai.ts`'s `captureGeneration` member and its `AiGenerationEventInput` import
- from `queues/recipe-enrichment/lib/capture.ts`: `buildGenerationEvent`,
  `sendGenerationEvent`, `captureGeneration`, `captureGenerationFailure`,
  `GenerationEventInput`, `GenerationUsage`, `GenerationPricing`, `GenerationError`,
  `AI_GENERATION_EVENT`, `envFloat`, and the now-false "Manual, not `@posthog/ai`"
  doc comment.
  **Keep** `PIPELINE_DISTINCT_ID`, `AI_FEATURE`, `RecipeOrigin`,
  `buildDisagreementEvent`, `sendDisagreementEvent`, `DISAGREEMENT_EVENT` — the
  disagreement event is a domain event with no LLM-observability equivalent and stays
  on `posthog-node`.
- the corresponding cases in `lib/capture.test.ts`. Replace the generation-event cases
  with tests over the new telemetry wiring (an in-memory span exporter asserting
  attributes and the redaction property from §4); do not keep dead tests alive by
  bending the new code to the old shapes.

`plugins/posthog.ts`'s `client` stays — the disagreement event and any other product
event still need it.

## Constraints

- **Match the surrounding code's voice.** This codebase's modules carry long,
  argued doc comments that explain _why_, name the alternatives rejected, and flag
  contractual strings. Your new modules must read the same way. When you delete the
  "Manual, not `@posthog/ai`" comment, replace it with an equally specific one
  explaining that `withTracing` rejects AI SDK v7 models and the OTel processor is
  PostHog's supported path — so the next reader does not re-open this.
- No new top-level workspace deps; everything lands in `services/pipeline`.
- Preserve fail-closed behaviour: no PostHog config → no telemetry, no crash, no
  behaviour change to the job itself. Telemetry failure must never fail a job.
  `plugins/posthog.ts` and `capture.ts` both state this; keep it true.
- Table/property naming: app-owned properties stay `snake_case`; PostHog's own stay
  `$ai_`-prefixed.
- Update `services/pipeline/.env.example` for any env var added, removed, or changed
  in meaning, with the same comment density the file already has.

## Verification (all of these, not a subset)

1. `pnpm --filter @buttery/pipeline typecheck`
2. `pnpm --filter @buttery/pipeline test`
3. `pnpm lint` and `pnpm format:check`
4. `pnpm why ai` from `services/pipeline` shows exactly one `ai` version.
5. A test proving `local`-origin generations leak no prompt/output text (§4).
6. **An end-to-end check against the real PostHog project.** The repo already has a
   devtools "run LLM enrichment" button (commit `fa5e37d`) and a real-database test
   (`a13f7d9`) — use them. Run one enrichment with `POSTHOG_ENABLED=true` and confirm
   a `$ai_generation` appears under AI Observability → Generations for project
   "Buttery" (538428) carrying `ai_feature=recipe-llm-enrichment`, the recipe
   properties, the prompt name/version, and a sane `$ai_latency` and token count.
   `mise`/`process-compose` bring the local stack up (`pnpm dev`; pg on 55432, redis
   on 56379). **If you cannot complete this step, say so explicitly in your final
   report — do not describe the change as verified.**

## Journal

This repo keeps a decision journal (`npx coherence`). Record, at minimum:

- which of §3(a)/§3(b) you chose and what you rejected
- how you resolved the merge-counts ordering problem in §3
- how you resolved the pricing question in §5, including the query or doc that decided it
- the §6 failure-semantics split

One entry already exists recording that `withTracing` is unusable here and why —
`npx coherence orient` will surface it. Do not duplicate it.

## Report back

Write your implementation log to `docs/plans/results/` (repo convention — one file per
plan, named after this one).

State plainly: what landed, what you verified and how, what you could not verify, and
any place where the native path is genuinely worse than what it replaced (there may be
one or two — say so rather than smoothing it over).
