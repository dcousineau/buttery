# Pipeline: Fastify plugins as the dependency-injection spine

**Date:** 2026-08-27
**Service:** `services/pipeline`
**Prereq:** the recipe-enrichment restructure (6 steps → 2, `llm/` folded into `lib/`) must be merged into the working tree first.

## 1. Why

The pipeline has three entrypoints (`server.ts`, `worker.ts`, `run-once.ts`) and every shared resource
is a hand-rolled lazy module singleton with a matching manual teardown:

| Resource                    | Today                                             | Teardown                            |
| --------------------------- | ------------------------------------------------- | ----------------------------------- |
| Redis client                | `src/redis.ts` `getRedis`/`requireRedis`          | `closeRedis()`, called in 3 places  |
| Queues + FlowProducer       | `src/queues.ts` `getQueues`/`getFlowProducer`     | `closeQueues()`, called in 3 places |
| pg pool (atproto-sync)      | `workflows/atproto-sync/lib/db.ts` `getPool`      | `workflow.close`                    |
| pg pool (recipe-enrichment) | `workflows/recipe-enrichment/lib/db.ts` `getPool` | `workflow.close`                    |
| PostHog client              | `workflows/recipe-enrichment/lib/posthog.ts`      | `workflow.close`                    |
| Config                      | `src/config.ts` `loadConfig()`                    | n/a                                 |

Two pg pools exist because a pool is workflow-scoped for no reason other than that there was nowhere
else to put it. `requireRedis()` throws at runtime if an entrypoint forgot to call `getRedis()` first —
an ordering contract enforced by a thrown error rather than by construction. The workflow registry is a
hand-maintained array (`src/workflows/index.ts`) that every new workflow must remember to edit.

Fastify is already a dependency and already the server. Making it the composition root replaces every
row of that table with one plugin that owns its resource and declares its own `onClose`, and replaces
the registry array with `@fastify/autoload`.

Reference implementation the user pointed at: `/Users/dcousineau/Projects/orange/orange-api/services/notifications/src`
— `app.ts` (autoload `plugins/` then `handlers/`), `plugins/db.ts` (decorate + `onClose`),
`plugins/sqs.ts` (decorate a _registration function_, `onReady` starts consumers, `preClose` drains them).
`plugins/sqs.ts` is the direct model for `plugins/workflow.ts` here.

**One deliberate improvement over the reference:** that codebase relies on autoload's alphabetical file
order and manually registers `env` before the autoload call. Every plugin here instead declares
`fp(fn, { name, dependencies })`, so the graph is explicit and Fastify throws at boot on a missing or
mis-ordered dependency instead of producing an `undefined` decorator.

## 2. Target tree

```
services/pipeline/src/
  app.ts                  composition root: FastifyPluginAsync<{ role }>
  server.ts               role "server"  — listens, board + API + autoscaler
  worker.ts               role "worker"  — listens (health only), drains queues
  cli/
    run-once.ts           role "cli"     — run one workflow in-process
    backfill.ts           role "cli"     — claim a batch and fan out plain jobs
  plugins/
    env.ts        name "env"        deps []                     all roles
    health.ts     name "health"     deps []                     all roles
    redis.ts      name "redis"      deps ["env"]                all roles
    db.ts         name "db"         deps ["env"]                all roles
    posthog.ts    name "posthog"    deps ["env"]                all roles
    ai.ts         name "ai"         deps ["env", "posthog"]     all roles
    workflow.ts   name "workflow"   deps ["env", "redis"]       all roles
    board.ts      name "board"      deps ["env", "workflow"]    server only
    autoscale.ts  name "autoscale"  deps ["env", "workflow"]    server only
  lib/
    bullmq/
      kernel.ts           StepSpec / WorkflowSpec / StepContext types + step dispatch
      hosts.ts            jobHost / consoleHost   (from src/workflows/hosts.ts)
      reconcile.ts        schedules + fleet-wide concurrency
      backlog.ts          (from src/backlog.ts)
    ai/
      provider.ts         resolveProvider
      prompt-fetch.ts     PostHog prompt fetch + TTL cache
      capture.ts          $ai_generation event construction + send
      errors.ts           modelRawText
    autoscale.ts          the pure scaling policy (from src/autoscale.ts)
    lock.ts               (from src/lock.ts)
  workflows/
    demo/index.ts
    atproto-sync/index.ts        + lib/
    recipe-enrichment/index.ts   + lib/
```

Every current top-level module has an assigned fate — nothing is left where it is by default:

| Today                                          | Fate                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `src/config.ts`                                | folded into `plugins/env.ts`                                             |
| `src/env.ts` (`loadEnvFile`)                   | folded into `plugins/env.ts` (first statement, before the zod parse)     |
| `src/redis.ts`                                 | `plugins/redis.ts`                                                       |
| `src/queues.ts`                                | `plugins/workflow.ts` (it owns the Queue map + FlowProducer)             |
| `src/reconcile.ts`                             | `lib/bullmq/reconcile.ts`, called from `plugins/workflow.ts`'s `onReady` |
| `src/autoscale.ts`                             | split: policy → `lib/autoscale.ts`, poll loop → `plugins/autoscale.ts`   |
| `src/backlog.ts`                               | `lib/bullmq/backlog.ts`                                                  |
| `src/lock.ts`                                  | `lib/lock.ts` (pure — takes a Redis client, holds nothing)               |
| `src/log.ts`                                   | deleted; `fastify.log` replaces it (14 importers — see D8)               |
| `src/server.ts`                                | thin role bootstrap; its board/auth/routes → `plugins/board.ts`          |
| `src/worker.ts`                                | thin role bootstrap; its Worker construction → `plugins/workflow.ts`     |
| `src/run-once.ts`                              | `src/cli/run-once.ts`                                                    |
| `src/workflows/define.ts`                      | `plugins/workflow.ts` + `lib/bullmq/kernel.ts`                           |
| `src/workflows/hosts.ts`                       | `lib/bullmq/hosts.ts`                                                    |
| `src/workflows/index.ts`                       | deleted — autoload replaces it                                           |
| `src/workflows/*/lib/db.ts` (both)             | deleted — `plugins/db.ts` replaces both                                  |
| `src/autoscale.test.ts`, `src/backlog.test.ts` | move alongside their modules under `lib/`, otherwise unchanged           |

## 3. Decisions

**D0 — The rule, not the list: anything with a lifecycle is a plugin.** If a module owns a connection, a
long-lived loop, a timer, a cache, a client that must be flushed, or anything else that has to be _started_
and _stopped_, it is a `src/plugins/*.ts` and it owns its own teardown hook. Nothing in `src/lib/` may hold
process-global mutable state — `lib/` is pure functions and types the plugins call.

The plugin list in §2 is what that rule produces for the code as it stands today, not a quota. The
autoscaler is a plugin because it runs a `setInterval` poll loop. Bull Board is a plugin because it mounts
routes and holds queue adapters. If the implementer finds a module the list missed that has a lifecycle,
the rule decides it: make it a plugin, and note the addition in the results log.

**D1 — One app, three roles.** `app.ts` is a `FastifyPluginAsync<{ role: "server" | "worker" | "cli" }>`.
Each entrypoint boots a Fastify instance and registers it with a role; autoload passes `{ role }` through
as plugin options, and role-specific plugins return early. _Rejected:_ three separate app files — the
plugin set is ~90% shared and drift between them is exactly the bug class this refactor exists to kill.

The worker becomes a real Fastify instance that listens and serves `/health`. It does not today, so
Railway cannot healthcheck the worker service; this is a small win that falls out of the shape.

**D2 — `plugins/env.ts` uses zod, not `@fastify/env`.** The reference uses `@fastify/env`
(ajv + env-schema + JSON Schema). This repo already depends on zod 4 and nothing in it uses ajv. The
plugin parses `process.env` with a zod schema and decorates a frozen `fastify.env` — identical call shape
(`fastify.env.REDIS_URL`), no new dependency tree, and the same fail-at-boot behavior. `loadConfig()` and
`loadAutoscaleConfig()` collapse into this one schema.

**D3 — Every plugin declares `name` and `dependencies`.** See §1.

**D4 — One pg pool for the service.** `plugins/db.ts` decorates `fastify.db` (a `pg.Pool`) and ends it in
`onClose`. Both `workflows/*/lib/db.ts` are deleted. Functions that take `pool: Pool` today keep taking it;
the workflow passes `fastify.db`.

**D5 — Steps get their dependencies from the enclosing plugin's closure, not from the step context.**
A workflow module is a Fastify plugin, so `fastify` is in scope inside every `run` function — the same way
`handlers/*.ts` in the reference reach `fastify.db("service")`. `ctx.redis` is therefore removed from
`StepContext`; `lock.ts`'s `acquireLock(fastify.redis, ...)` is called with the decorator directly.

**D6 — `defineWorkflow` becomes `fastify.workflow(spec)`.** Direct analog of the reference's
`fastify.sqs(queueUrl, type, opts, handleMessage)`. The plugin owns the `Map` of registrations, creates a
`Queue` per workflow and one shared `FlowProducer`, constructs `Worker`s in `onReady` when the role is
`worker`, reconciles schedules and concurrency in `onReady` when the role is `server`, drains workers in
`preClose`, and closes queues in `onClose`.

**D7 — `@fastify/autoload` replaces the workflow registry.** `src/workflows/` contains _only_ workflow
folders after the kernel files move to `src/lib/bullmq/`, so autoload needs no ignore patterns. Adding a
workflow becomes adding a folder — `src/workflows/index.ts` and `findWorkflow` are deleted.

**D8 — Fastify's logger replaces `src/log.ts`.** Mixed logging is worse than either end, so this is in
scope, not a follow-up. 14 modules import `#/log.ts`; all move to `fastify.log`, reached through the plugin
closure the same way `fastify.db` is. Configure the Fastify logger to emit the JSON shape `src/log.ts`
emits today so Railway's log search keeps working. The step context keeps its own `log` — that writes to
the BullMQ job log, which is a different sink and stays.

If any of the 14 sites turns out to have no `fastify` in scope (a pure `lib/` function that logs), that is
a signal the function should return or throw instead of logging. Fix it that way, or, if that is too
invasive for one site, leave a `console` call and record it in the results log — do not reintroduce a
module-global logger.

## 4. Risks the implementer must verify, not assume

- **`@fastify/autoload` under Node's native TypeScript.** This service runs `.ts` directly via
  type-stripping (`node src/server.ts`), with no build step. Autoload globs a directory and imports what it
  finds. Verify it actually discovers and loads `.ts` files here before building anything on top of it —
  it may need an explicit `matchFilter`/`extensions` option, or `import.meta.url`-based path resolution
  (`__dirname` does not exist in ESM; use `fileURLToPath(new URL("./plugins", import.meta.url))`).
  **If autoload cannot be made to work, stop and report — do not silently fall back to a hand-written
  registry, since dynamic loading is half the point of the task.**
- **Plugin encapsulation.** A decorator added inside a non-`fp`-wrapped plugin is invisible to siblings.
  Every plugin in `src/plugins/` must be `fp`-wrapped. Workflow modules in `src/workflows/` must **not** be
  — they consume decorators and register into the parent, they do not export any.
- **`onReady` vs `preClose` vs `onClose` ordering.** Workers must stop fetching and finish in-flight jobs
  (`preClose`) _before_ the pool and Redis close (`onClose`), or a draining replica kills a job mid-write.
  The reference calls this out in a comment on `plugins/sqs.ts` — get it right here.
- **`globalConcurrency` and `schedule` are currently functions** (`() => number | undefined`) purely so
  they read `process.env` lazily, after `.env` load. With `fastify.env` parsed at boot before any workflow
  registers, they can become plain values. Make them plain values.

## 5. Phases — each ends at a green `pnpm typecheck && pnpm test`

**Phase 1 — infrastructure plugins.** `app.ts`, `plugins/{env,health,redis,db,posthog,ai}.ts`,
`src/lib/ai/*`. Rewrite `server.ts` and `worker.ts` as role bootstraps. The workflow kernel still works the
old way in this phase, bridged: `defineWorkflow` stays, but its consumers read `fastify.db` / `fastify.redis`
instead of the deleted singletons. Delete `src/config.ts`, `src/env.ts`, `src/redis.ts`, both
`workflows/*/lib/db.ts`.

This phase also absorbs the separately-requested extraction: `capture.ts`, `provider.ts`, `prompt-fetch.ts`
and `modelRawText` move out of `workflows/recipe-enrichment/lib/` into `src/lib/ai/`, behind
`fastify.ai`. What stays workflow-owned is anything that knows what a recipe is: the
`captureGeneration`/`captureGenerationFailure` wrappers, the disagreement event, `AI_FEATURE`,
`PROMPT_NAME`, `LLM_ENRICHMENT_FLAG`, `buildRecipeJson`, `merge.ts`, `schema.ts`, `prompt.ts`,
`classify.ts`, `classifiers/`, `load.ts`.

`provider.ts` reads `LLM_ENRICHMENT_MODEL`, `LLM_ENRICHMENT_PROVIDER` and `MOONSHOT_API_KEY` — names that
are workflow-specific for a now-generic module. **Keep the names.** Renaming them is a Railway environment
change, out of scope here. Leave a one-line note.

**Phase 2 — the workflow plugin.** `plugins/workflow.ts` (`fastify.workflow(spec)`), `src/lib/bullmq/*`,
autoload of `src/workflows/`. Convert all three workflow modules to plugins. Delete `src/workflows/define.ts`,
`hosts.ts`, `index.ts`, `src/queues.ts`, `src/reconcile.ts`. Move `board.ts` and `autoscale.ts` into plugins.
Rewrite `run-once.ts` as `src/cli/run-once.ts`.

**Phase 3 — the backfill CLI.** `src/cli/backfill.ts`, role `cli`. Consumes the `claimBatch` /
`claimLlmBatch` SQL that already exists in `workflows/recipe-enrichment/lib/load.ts` (kept deliberately when
the backfill _steps_ were deleted). Claims a batch, adds N plain jobs to the queue with the deterministic
job ids (`enrichJobId` / `llmEnrichJobId`), prints the counts, exits. No parent job, no report step.

```
pnpm --filter @buttery/pipeline backfill [--llm] [--limit=N] [--force] [--local-only]
```

Add the `backfill` script to `services/pipeline/package.json`.

**Phase 4 — docs.** `services/pipeline/README.md` (architecture section, the folder tree, the workflow
table, the backfill instructions) and the pipeline bullets in the repo-root `AGENTS.md`. Keep AGENTS.md's
terse style and its current length.

## 6. Out of scope

- Renaming `LLM_ENRICHMENT_*` / `MOONSHOT_API_KEY` environment variables.
- Any change to what a step computes. This is a wiring refactor: the SQL, the classifiers, the merge
  policy, the prompt and the BullMQ retry/backoff numbers are all carried over byte-for-byte.
- `atproto-sync`'s flow graph. `enumerate → sync-repo × N → finalize` stays — `finalize` folds outcomes,
  reconciles missing repos and releases the sweep lock, and genuinely needs `waiting-children`.

## 7. Verification

```
pnpm --filter @buttery/pipeline typecheck
pnpm --filter @buttery/pipeline test
pnpm --filter @buttery/pipeline test:db      # SKIPs without a database; a FAILURE is not acceptable
pnpm --filter @buttery/web typecheck         # imports @buttery/pipeline-contract
```

Then boot each role and confirm it starts clean and shuts down without hanging (an unclosed pool or Redis
socket keeps the event loop alive — that is the specific regression this refactor can introduce):

```
node src/server.ts        # /health responds, /ui loads, then SIGINT exits within a second
node src/worker.ts        # /health responds, logs its queues, then SIGINT exits within a second
pnpm --filter @buttery/pipeline run:once demo --tasks=3
```

## 8. Results log

On completion, write `docs/plans/results/2026-08-27-pipeline-fastify-di-results.md` recording what was
built, every deviation from this plan and why, anything discovered that the plan got wrong, and the
verbatim output of each verification command.
