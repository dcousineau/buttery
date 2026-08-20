# `@buttery/worker`

Buttery's background work, as [Temporal](https://temporal.io) workflows: durable
executions that survive the process running them.

Today that is one real workflow — the hourly atproto sweep, which used to be a
Railway cron service — plus a reference workflow that exists to be watched. The
shape is chosen for what comes next: a pipeline per recipe write (rendered tags,
derived data, an LLM pass) and publishing, both of which are long, multi-step,
partly-third-party, and unpleasant to make correct with retries alone.

This service is also one half of an experiment. The other half is
[#39](https://github.com/dcousineau/buttery/pull/39), which does the same job on
BullMQ. [What it costs, what it buys](#what-it-costs-what-it-buys) at the bottom
is the comparison.

## Three entrypoints, one long-running

| Process                    | Entrypoint              | What it is                                                        |
| -------------------------- | ----------------------- | ----------------------------------------------------------------- |
| `worker` (Railway service) | `src/worker.ts`         | Polls the task queue, runs workflows and activities. The service. |
| `schedules:sync`           | `src/schedules-sync.ts` | Reconciles Temporal Schedules, then exits. Railway `preDeploy`.   |
| `run:once` / `sync:once`   | `src/run-once.ts`       | Starts one workflow from a shell and waits. Not deployed.         |

There is no producer service and no dashboard service. Starting a workflow is a
client call from anywhere with the address; the dashboard is the cluster's own
Web UI.

## Workflows

A workflow is a folder, one entry in `WORKFLOWS` (`src/workflows/index.ts`), and
one line in each of the two barrels:

```
src/workflows/
  define.ts         what a registration is — and why the kernel is so much smaller than BullMQ's
  index.ts          the registry: WORKFLOWS
  bundle.ts         the workflow bundle: every entrypoint, under the name it is started by
  activities.ts     every activity implementation, merged with a collision check
  id.ts             workflow ids, which are also this service's mutual exclusion
  demo/             the reference workflow
  atproto-sync/     index.ts, workflow.ts, plan.ts, activities.ts, types.ts, lib/
```

and inside a workflow folder:

| File            | Runs where              | Holds                                                        |
| --------------- | ----------------------- | ------------------------------------------------------------ |
| `index.ts`      | Node, at import         | Registration: name, schedule, singleton, CLI flag parsing    |
| `workflow.ts`   | **Sandbox**             | Orchestration. The whole algorithm, in one readable file     |
| `plan.ts`       | **Sandbox**             | Pure helpers the workflow calls — batching, folding counters |
| `activities.ts` | Node, per activity      | Activity entrypoints: thin wrappers, the retry boundaries    |
| `types.ts`      | both (types only)       | What the two sides exchange — the wire format                |
| `lib/`          | Node, inside activities | What the work actually is: `pg`, `fetch`, atproto            |

### The sandbox rule

Workflow code is bundled and run in a deterministic isolate: no `process`, no
clock, no randomness, no I/O. That is what makes a run replayable, and replay is
what makes it durable. So `workflow.ts` may import `types.ts`, `plan.ts`, and
`activities.ts` **for its types only** — reaching into `lib/` from a workflow is
the one mistake this layout is shaped to prevent.

`bundle.test.ts` builds the bundle exactly as the worker does at boot, so that
mistake is a red test rather than a red deploy. It is the slowest test here by an
order of magnitude and worth every second: it is the one class of error in this
service that types do not catch.

### The other thing that is not a type error

The export name in `bundle.ts` **is** the workflow type — the string a client
puts in a StartWorkflow request. A mismatch produces a workflow that starts
happily and then fails every workflow task with `no such function is exported by
the workflow bundle`. `registry.test.ts` checks the registry and the bundle
agree, and `bundle.ts` quotes its export names (`export { atprotoSync as
"atproto-sync" }`, ES2022 arbitrary module namespace names) so the type can stay
the same kebab-case identifier the CLI, the schedule id and the registry use.

## The atproto sweep

Same algorithm it always was — enumerate → index → reconcile — cut at the seams
it already had. What changed is what supervises it:

```
enumerateRepos          → every DID holding an exchange.recipe.recipe record
openSyncRun             → the atproto_sync_run row
indexRepoBatch × N      → 100 DIDs at a time, SYNC_CONCURRENCY in flight, heartbeating
reconcileMissingRepos   → flag DIDs that dropped out (full, non-dry sweeps only)
closeSyncRun            → the mirror of open
```

Three details worth knowing:

- **Batching is the one structural decision.** One activity for the whole
  network puts a multi-thousand-repo retry behind one failure; one activity per
  repo puts thousands of events in the history. A batch is the middle, and it is
  the unit of both retry and progress.
- **`dids` lives in workflow state, which means it lives in the history.** A few
  thousand DIDs is ~150 KB against a 2 MB payload limit — fine now, not fine
  forever. `workflow.ts` documents the fix (page enumeration behind a cursor,
  reconcile by run timestamp, `continueAsNew`) for the day it stops being fine.
- **A repo that fails does not fail the sweep.** Its error goes to
  `atproto_repo.last_error`; an hourly sweep that failed whenever one of
  thousands of PDSes was unreachable would simply always be failing. What does
  fail a batch is our own database going away, which is the case worth retrying.

## Schedules

Schedules live in the cluster and outlive every deployment, so they are
**reconciled**, not registered: a workflow whose `schedule()` returns undefined
has its schedule deleted. Emptying `ATPROTO_SYNC_SCHEDULE` genuinely turns the
sweep off rather than orphaning one that keeps firing from a config nothing in
the repo mentions. Everything is UTC.

`schedules:sync` is a deploy step (Railway `preDeploy`), not a background loop —
it runs once per deploy, in the built image, before any new container serves, and
a non-zero exit aborts the deploy.

**Overlap** is the schedule's `SKIP` policy: a firing that lands while the
previous run is still going is dropped, because the work is already being done.
For the other overlap — someone running `sync:once` while a scheduled sweep is in
flight — see `src/workflows/id.ts`: a `singleton` workflow always uses the same
workflow id, and Temporal refuses to start a second running execution under one.
(Scheduled runs get the firing time appended to their id by the cluster, so
`run-once.ts` also does a visibility check before starting. It is eventually
consistent, and says so.)

## Local dev

`pnpm dev` boots a local cluster and this worker beside the rest of the stack:

|               |                                                                |
| ------------- | -------------------------------------------------------------- |
| Temporal UI   | <http://127.0.0.1:8233>                                        |
| Temporal gRPC | `127.0.0.1:7233`                                               |
| History       | `.dev-data/temporal/dev.db` — survives restarts, `rm` to reset |

```bash
pnpm --filter @buttery/worker run:once demo --label=hello
pnpm --filter @buttery/worker run:once demo --fail        # watch a retry resume
pnpm --filter @buttery/worker sync:once --dry-run
pnpm --filter @buttery/worker schedules:sync

process-compose process scale worker 3   # several workers, one task queue
temporal workflow list                   # the CLI defaults to 127.0.0.1:7233
```

The `worker` process does not hot-reload: `node --watch` kills the SDK's
workflow sandbox on boot with `RangeError: Invalid atomic access index` (Node
26.7, reproducible, gone without the flag). Restart it instead —
`process-compose process restart worker`.

`run:once` starts a workflow and waits; the `worker` process runs it. That is a
real difference from a queue library's one-shot, which did the work in your
shell — here the stack has to be up. What it buys is that a run by hand and a
scheduled run are the same execution, on the same fleet, with the same history
and the same UI page.

`services/worker/.env` (from `.env.example`, created by `pnpm dev`) answers both
"how do I reach Temporal" and "which atmosphere does a sweep read".
`ATPROTO_SYNC_SCHEDULE` is blank there on purpose.

## Deployment

`.railway/railway.ts` is the source of truth. Temporal is self-hosted, modelled
on Railway's own [no-Elasticsearch
template](https://railway.com/deploy/temporal-or-durable-workflows-no-elastic):

| Service             | Image                          | Why                                 |
| ------------------- | ------------------------------ | ----------------------------------- |
| `temporal-postgres` | Railway Postgres               | Main + visibility schemas           |
| `temporal`          | `temporalio/auto-setup:1.29.7` | The server; creates schemas on boot |
| `temporal-ui`       | `temporalio/ui:2.53.1`         | The dashboard                       |
| `temporal-auth`     | `railway-caddy-basic-auth`     | The UI has no login of its own      |
| `worker`            | this repo                      | Our code                            |

Notes for whoever applies it:

- Nothing here has been applied. The graph evaluates and passes `validateGraph`;
  `railway config plan` needs auth this session did not have.
- Retiring `atproto-cron-sync` is a **destructive** plan item —
  `railway config apply --confirm-destructive`.
- `temporal-auth` has no domain yet (Railway owns generated domains and
  `config pull` omits them): `railway domain --service temporal-auth`, then set
  `TEMPORAL_CORS_ORIGINS` on `temporal-ui` to that origin.
- `NUM_HISTORY_SHARDS=512` is set at creation and **cannot be changed** —
  changing it means a new cluster.
- The 7233 TCP proxy is an unauthenticated gRPC endpoint on the public internet.
  Self-hosted Temporal has no auth of its own; that is what Temporal Cloud sells.
  It is there so the CLI can reach the cluster. Delete it if that trade stops
  looking good.

## Testing

```bash
pnpm --filter @buttery/worker test      # unit + the bundle build; needs nothing running
pnpm --filter @buttery/worker test:db   # *.db.test.ts against the dev Postgres
```

The `db` suites skip themselves without a database, so `pnpm test` stays green on
a fresh clone.

## What it costs, what it buys

Measured against [#39](https://github.com/dcousineau/buttery/pull/39), which is
the same sweep on BullMQ.

**What Temporal owns that we would otherwise write:**

| The problem                         | BullMQ build                                                                                                     | Here                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A retry restarts a long job         | A step kernel: cursor in job data, `resumeOnRetry`, opt-in per workflow because resuming is only sound sometimes | Workflow history. Completed activities do not re-run, and there is no flag because there is no unsound case |
| Two runs at once                    | Redis mutex, TTL, heartbeat, skip-on-contention                                                                  | Schedule `SKIP` policy + workflow id                                                                        |
| A schedule that outlives its config | Reconcile job schedulers in Redis, from a process that is always up and that there is exactly one of             | Same reconcile, as a deploy step — no process has to own it                                                 |
| Watching a run                      | A Fastify service, Bull Board, basic auth, a healthcheck, a place in the IaC                                     | A container with one variable                                                                               |
| Backlog                             | An autoscaler: a control loop, a Railway API token, a scale-down cooldown, nine tests                            | Workers pull when they have capacity; `replicas` is a number in the IaC                                     |

Counting the service machinery on both sides — every file that is not the sweep
itself, not a test, and not a comment — that is **864 lines there against 373
here**. The difference is almost entirely the five rows above. What is left on
this side is registration, a schedule reconciler, and three thin entrypoints.

**What it costs:**

- **Four services that did not exist.** BullMQ ran on the Redis the app already
  had. Temporal is a server, a Postgres, a UI and an auth proxy — call it
  ~1 GiB of memory and a second database before a single workflow runs. This is
  the number to weigh; everything else is small.
- **A split that types cannot fully enforce.** Sandbox code and Node code look
  identical in an editor. `bundle.test.ts` catches the mistake; nothing catches
  it while you type.
- **New failure modes to learn.** Non-determinism on replay, payload size
  limits, history event counts, `nonCancellable` cleanup — none of them hard,
  all of them unfamiliar, and all of them things a queue simply does not have.
- **Local dev needs a cluster.** One binary and one process-compose entry, but a
  shell one-shot can no longer do the work with nothing running.
- **Self-hosting means no auth.** Both the UI and the gRPC endpoint are
  protected by "nobody knows the URL" unless you put something in front of them.
  Temporal Cloud solves this and costs money instead.

**Where it pays off is the work that is coming, not the work that is here.** The
hourly sweep is a batch job; a queue runs batch jobs fine. A per-recipe pipeline
that calls an LLM, waits on a third party, and has to be exactly-once from the
user's point of view is where a step cursor in job data stops being enough — and
that is the thing to picture when reading both branches.
