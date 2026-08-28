# Results: PostHog-native AI observability

Execution log for the plan at
[`../2026-08-28-posthog-native-ai-observability.md`](../2026-08-28-posthog-native-ai-observability.md),
on branch `claude/llm-enrichment`.

The hand-rolled `$ai_generation` builder is gone. Generations reach PostHog as
OpenTelemetry spans emitted by the AI SDK itself, through
`@posthog/ai/otel`'s `PostHogSpanProcessor`.

## What landed

| Path                                   | What                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/plugins/telemetry.ts`             | **new** — registers the tracer provider + PostHog span processor; `forceFlush` on `onClose`               |
| `src/lib/ai/telemetry.ts`              | **new** — `generationTelemetry(...)`, the per-call `telemetry` options builder                            |
| `src/lib/ai/telemetry.test.ts`         | **new** — in-memory span exporter; the redaction proof                                                    |
| `src/lib/ai/capture.ts`                | **deleted** — the generic `$ai_generation` builder                                                        |
| `src/plugins/ai.ts`                    | `captureGeneration` removed; `dependencies` trimmed to `["env"]` (it no longer touches `fastify.posthog`) |
| `.../recipe-enrichment/lib/capture.ts` | generation machinery deleted; two domain events added; disagreement event untouched                       |
| `.../recipe-enrichment/index.ts`       | `generateText` now carries `telemetry`; the two capture calls became the two domain events                |
| `.env.example`                         | pricing comment rewritten; a new AI-observability section                                                 |

## The four decisions the plan asked for

**§3 — per-call `telemetry.integrations` (option b), not `runtimeContext` (option a).**
`@ai-sdk/otel` passes `runtimeContext` to `enrichSpan` for `generateText`/`streamText`
but not for object generation, and this call site is `generateText` with
`Output.object(...)` — near enough that boundary that relying on it means depending on
which side of a documented caveat we land. A closure has the values in scope, so the
question does not arise.

**§3 ordering — the merge counts ride their own event.** `enrichSpan` fires at span
_creation_; `labels_written` and `disagreements` only exist after `mergeLlmLabels` has
run. There is no hook late enough. So the pre-call facts (recipe, prompt, model, and
both line counts, which _are_ known early) go on the span, and the post-merge outcome
goes on `llm_enrichment_completed` keyed by the same `$ai_trace_id`. Dropping them was
the alternative and would have cost the only numbers that say whether the pass is doing
anything useful.

**§6 — a schema rejection is not a failed generation.** The old path emitted one
`$ai_generation` with `$ai_is_error` for _any_ throw. The native path splits it, and the
split is more truthful: a transport failure happens inside `doGenerate`, so the SDK's own
span records the error for free; a schema rejection happens _above_ the model layer —
`doGenerate` succeeded, the tokens were spent, only the parse failed — so the generation
span records a success, because a success is what it was. That retires the `$ai_is_error`
signal, so `llm_enrichment_failed` carries it instead, with the same trace id, the
message, the model's raw text, and a `schema_rejection` boolean. Deliberately **not** a
second `$ai_generation`: one model call must stay one generation in the cost and volume
numbers.

**§5 — pricing: kept and emitted, but UNVERIFIED.** See "What is not verified" below.

## Two places the plan was wrong, both found by measuring

**`NodeSDK` does not work here.** The plan specifies
`new NodeSDK({ spanProcessors: [...] })`. Built that way, spans were genuinely recording
(`SpanImpl`, `isRecording() === true`) and **zero were exported**. The obvious suspect —
two copies of `@opentelemetry/sdk-trace-base`, so the processor class came from a
different module instance than the provider used — was checked and refuted: resolving
that package from the pipeline and from inside `@opentelemetry/sdk-node` returns the same
path. Swapping in `BasicTracerProvider` with the identical processor exported
immediately. `NodeSDK` registers a provider but does not wire a caller-supplied
`spanProcessors` array on this version.

That is the better shape anyway: `NodeSDK` exists to bootstrap auto-instrumentation,
metrics and logs — a stack this service does not want. `@opentelemetry/sdk-node` was
installed per the plan and then **removed**: grepping `src/` for it found one hit, in a
comment. A dependency with no subject is a finding, not a feature. The four that remain
all have one: `api` and `sdk-trace-base` are imported directly, `resources` supplies
`service.name`, and `exporter-trace-otlp-http` is what `PostHogSpanProcessor` imports —
kept as a direct dependency so that peer resolution is explicit rather than hoisted
luck, which is the plan's own reasoning.

Note also that `BasicTracerProvider` has no `.register()` — that is
`NodeTracerProvider`'s convenience method, from a package we do not depend on.
`trace.setGlobalTracerProvider(provider)` is the same thing without it.

**A telemetry plugin beats an entrypoint import.** The plan reasons about
`node --import` versus a side-effecting import at the top of each of the three
entrypoints. Neither is needed: `generateText` runs inside a BullMQ job, long after
`buildApp()` has returned. The provider only has to exist before the first _span_, not
the first _import_. Verified — registering the provider after `ai` is already imported
still captures every span. As a plugin it gets the repo's own idioms: one shutdown path
through `onClose`, config from `fastify.env`, and no launch command to keep in sync
across Railway, `process-compose` and `package.json`.

## Verified

| Check                                       | Result                     |
| ------------------------------------------- | -------------------------- |
| `pnpm --filter @buttery/pipeline typecheck` | clean                      |
| `pnpm --filter @buttery/pipeline test`      | see below                  |
| `pnpm lint`                                 | clean                      |
| `pnpm why ai` from `services/pipeline`      | exactly one — `ai@7.0.83`  |
| §4 redaction proof                          | `lib/ai/telemetry.test.ts` |

**Fail-closed, measured both ways.** Booting the real app with PostHog disabled yields
`NonRecordingSpan` / `isRecording() === false` — the API's no-op tracer, no provider, no
exporter, no background timer. With `POSTHOG_ENABLED=true` and a token it yields
`SpanImpl` / `isRecording() === true`. That pair is the check that matters, because
"registered a provider" and "spans actually go somewhere" are exactly the two things
`NodeSDK` managed to disagree about.

**Redaction (§4) is proved, not asserted.** The suite drives a real `generateText` call
against a mock model and an in-memory span exporter, with sentinel strings in the
prompt, and asserts those sentinels appear in **no exported span attribute** for a
`local`-origin call, with `gen_ai.input.messages` / `gen_ai.output.messages` absent as
keys. The `sync` mirror asserts the content _is_ there — without that negative control
the first test would pass just as well if telemetry had silently broken entirely.

## What is NOT verified

**No end-to-end check against the real PostHog project** (plan §6 of Verification).
There are no PostHog credentials in this environment, so nothing was run against
us.posthog.com / project 538428. Everything above is against an in-memory exporter and a
mock model. **This change should not be described as verified end to end.** The first
real generation is what will confirm that PostHog's server side turns these spans into
`$ai_generation` events carrying the properties we put on them — in particular that
custom, non-`gen_ai.*` attributes (`ai_feature`, `recipe_id`, `prompt_name`, …) survive
the OTLP mapping into event properties. The processor only _filters_ on the
`gen_ai.`/`llm.`/`ai.`/`traceloop.` prefixes; it does no mapping itself, so the mapping
is entirely server-side and not observable from here.

**Pricing (§5) could not be resolved.** Whether PostHog's OTLP ingestion honours
`$ai_input_token_price` / `$ai_output_token_price` the way `posthog-node` capture did is
unknown: it needs either live project access or a docs page that states the mapping, and
both PostHog pages the plan cites truncate before their attribute-mapping sections. The
env vars are **kept** and the attributes **are emitted**, marked UNVERIFIED in the code
and in `.env.example`. Rationale: an ignored attribute yields _absent_ cost, not _wrong_
cost, so emitting is the option that cannot mislead. Recorded as a `blocked` journal
entry rather than silently decided.

## Where the native path is genuinely worse

Two, stated rather than smoothed over.

**Custom properties are now a guess until the first live generation.** The old builder
put properties on an event whose shape we controlled end to end; the test asserted the
exact object PostHog would receive. Now we set span attributes and trust a server-side
mapping we cannot see. The local tests prove the attributes are on the span — they cannot
prove PostHog reads them.

**The failure signal got quieter, on purpose.** `$ai_is_error` used to fire for every
throw. Now a schema rejection produces a green generation plus a separate
`llm_enrichment_failed` event. That is more accurate and it is also more work for whoever
reads it: any dashboard or evaluation built on `$ai_is_error` needs updating to the new
event, and nobody watching only `$ai_generation` will see schema rejections at all any
more.

Against that: latency, tokens, model, provider, http status and transport errors are now
recorded by the SDK rather than assembled by us, ~480 lines of hand-rolled event building
are gone, and the redaction control is enforced by the SDK's own `recordInputs` /
`recordOutputs` rather than by remembering to leave a key out of an object.
