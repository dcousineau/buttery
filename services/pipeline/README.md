# `@buttery/pipeline`

Buttery's data pipelines: a [BullMQ](https://docs.bullmq.io) job system on Redis,
a [Fastify](https://fastify.dev) server hosting the
[Bull Board](https://github.com/felixmosh/bull-board) UI, and a worker fleet that
Railway autoscales on queue depth.

One package, three entrypoints — two deployed, one for a shell:

| Process                             | Entrypoint        | What it is                                                          |
| ----------------------------------- | ----------------- | ------------------------------------------------------------------- |
| `pipeline` (Railway service)        | `src/server.ts`   | Producer + Bull Board UI + the autoscaler loop. Never runs a job.   |
| `pipeline-worker` (Railway service) | `src/worker.ts`   | One `Worker` per queue. No HTTP, no state — safe to add and remove. |
| `run:once` / `sync:once`            | `src/run-once.ts` | One workflow, start to finish, in this process. Not deployed.       |

They are split because the two things scale for different reasons. The board has
to be up whenever someone wants to look at it, and exactly one of it is enough;
the fleet needs to grow with the backlog and shrink when it drains. Deploying
them as one service would tie a dashboard restart to a scaling event, and a
scaling event to a dashboard restart.

## Routes

`GET /health` is unauthenticated — Railway's healthcheck has no credentials.
Everything else sits behind HTTP basic auth (`PIPELINE_AUTH_USER` /
`PIPELINE_AUTH_PASSWORD`):

| Route               | What it does                                             |
| ------------------- | -------------------------------------------------------- |
| `GET /health`       | Liveness, plus the queue names this build knows about    |
| `GET /ui`           | Bull Board                                               |
| `GET /workflows`    | What this build can run: steps and schedule per workflow |
| `GET /queues`       | Job counts per queue as JSON                             |
| `GET /autoscale`    | The autoscaler's last decision, or `{"enabled": false}`  |
| `POST /jobs/:queue` | Enqueue one job: `{"name"?: string, "data"?: unknown}`   |

The board is not read-only — it shows every job payload and lets a visitor
retry, promote and delete jobs — so `PIPELINE_AUTH_PASSWORD` is **required** when
`NODE_ENV=production` and the service refuses to start without it. Locally the
password is blank and there is no login prompt; the whole dev stack is
loopback-only.

## Workflows and steps

A **workflow** is one queue and the **steps** that drain it. A step is a _job_ —
not a phase inside one — and a workflow is the graph those jobs form: a step
declares the work that must finish before it runs, and BullMQ keeps it in
`waiting-children` until that work has. That graph is a
[flow](https://docs.bullmq.io/guide/flows), and `ctx.flow()` is the only thing in
this service that builds one.

Each workflow lives in one folder under `src/workflows/`:

```
src/workflows/
  define.ts             the kernel: what a workflow is, and what running one means
  hosts.ts              where a step reports to — a BullMQ job, or a terminal
  index.ts              the registry: WORKFLOWS
  demo/index.ts         the reference implementation, in one file
  atproto-sync/         a workflow with real code: steps.ts, plan.ts, types.ts, lib/
  recipe-enrichment/    the second one: index.ts, types.ts, lib/
```

```ts
// src/workflows/my-thing/index.ts
export const myThing = defineWorkflow({
  name: "my-thing",
  description: "One line, shown in /workflows and /queues",
  entry: "fetch",
  steps: [fetchIt, transformOne, writeAll],
});

const fetchIt: StepSpec = {
  name: "fetch",
  description: "Find the work, then fan it out",
  run: async ({ payload, flow }) => {
    const items = await discover(payload);
    await flow({
      step: "write-all",
      data: { count: items.length },
      children: items.map((item) => ({ step: "transform-one", data: item })),
    });
  },
};
```

Add it to `WORKFLOWS` in [`src/workflows/index.ts`](src/workflows/index.ts) and
you are done: the server builds a `Queue` so the board lists it and
`POST /jobs/my-thing` works, the worker builds a `Worker` for it, the autoscaler
starts counting its backlog, and `run:once my-thing` runs it from a shell.
Nothing else in the service is queue-aware.

### One job per step

Every step of every workflow is a job on the workflow's own queue, with the job's
`name` naming the step. That is what makes a step its own unit of:

- **retry** — a step declares its own `attempts` and backoff in `jobOptions`, so
  a repo whose PDS times out costs that repo its retries and nobody else's work;
- **failure** — a child that exhausts its attempts is stepped over and _counted_
  by its parent, instead of taking the whole run down;
- **distribution** — every step goes through the queue, so the fleet shares them
  instead of one worker looping alone; and
- **visibility** — the board shows each step as a job, with its own payload, log,
  duration, return value and place in the tree.

A step waiting on children occupies no worker while it waits, which is what makes
fanning a sweep out over thousands of repos reasonable rather than a way to pin a
process for an hour.

The whole graph lives on **one queue**, named for the workflow. Flows can span
queues and sometimes should; keeping one workflow's steps together means the
board groups them, `/queues` counts them as one backlog, and adding a step is not
a deployment concern.

### Fanning out, and how many run at once

`ctx.flow(node)` submits a step and everything that must finish first, in one
atomic call, so there is never a window where half a fan-out exists. Children get
`ignoreDependencyOnFailure`, which is what "counted, not fatal" means: a child
that fails for good leaves the parent's dependencies instead of failing it. A
step that wants the opposite says `opts: { failParentOnFailure: true }`.

`ctx.enqueue(workflow, node)` is the other direction: work handed to a **different**
workflow, on that workflow's own queue, merged with _that_ workflow's job options
for the step. It is `queue.add`, not a flow — no parent, no waiting, no atomic
tree — and the shape says so by having no `children`. A cross-workflow handoff
must not be a flow child, because a flow child is something the calling graph's
tail step waits on: `atproto-sync`'s `finalize` would sit in `waiting-children`
until every enrichment it triggered had finished, holding the sweep's hour-TTL
lock the whole time, and the next scheduled sweep would be skipped. A name that
is not a registered workflow, or a step that workflow does not define, throws at
the call — the same bargain `defineWorkflow` makes about its entry step, for the
same reason. Under `run:once` there is no queue and no fleet, so the console host
logs the intent and skips: cross-workflow work is another workflow's run, and
pretending otherwise would make `sync:once` quietly enrich the whole corpus on a
laptop.

**Nothing throttles the producer.** A step fans out every job it has and the
queue holds them — a queue that is a buffer is the point of having one. How many
actually run is `globalConcurrency`, a cap BullMQ enforces in Redis across every
worker there is:

| Limit                             | Bounds                             | Set by                             |
| --------------------------------- | ---------------------------------- | ---------------------------------- |
| `PIPELINE_WORKER_CONCURRENCY`     | one process                        | the environment, per service       |
| `globalConcurrency` on a workflow | the whole fleet, however it scales | the workflow, from the environment |

The fleet-wide one is the limit with no other home: a worker's concurrency
protects a machine, but "do not point fifty requests at the atmosphere from this
sweep" has to hold across replicas, and the autoscaler moves the replica count
around underneath it. `atproto-sync` sets it from `ATPROTO_SYNC_MAX_IN_FLIGHT`
(default 8) — verified: with three replicas and four slots each, twelve jobs
could have been active and exactly eight were. `recipe-enrichment` sets it from
`RECIPE_ENRICHMENT_MAX_IN_FLIGHT` (default 16), where it is what keeps a sweep of
thousands of repos from handing the fleet thousands of classifications and
crowding out everything else.

Like the schedules, it is reconciled onto the queue at server boot rather than
registered, so a workflow that stops declaring a cap has it removed.

### Overlap

BullMQ stops the same job running twice; it does not stop two _different_ jobs on
a queue, which is exactly what an hourly schedule plus a sweep that runs long
produces. The Railway cron this replaced got that from the platform, so losing it
would be a regression.

`atproto-sync` takes a Redis mutex ([`src/lock.ts`](src/lock.ts)) in `enumerate`
and releases it in `finalize` — so it spans the whole graph, not one job. A sweep
that cannot take it **skips**: it completes with `{"status": "skipped"}` rather
than failing, because the work is already being done and failing would only buy a
retry that hits the same lock. `sync:once` takes the same lock, so a sweep by hand
cannot run alongside a scheduled one.

Nothing heartbeats the lock — the holder is a graph, not a process — so the TTL is
a plain deadline, set to the schedule's own period. What it promises is "a sweep
may not start while the last one is still going, up to one period", and freeing it
then beats wedging the schedule forever if `finalize` never runs.

Set `jobOptions.removeOnComplete` / `removeOnFail` on every step. BullMQ keeps
finished jobs in Redis forever by default, and a fanned-out workflow produces a
job per item, so an unbounded queue becomes the largest thing in the instance
faster than you would expect.

## The workflows

| Queue               | Graph                                | What it does                                                    |
| ------------------- | ------------------------------------ | --------------------------------------------------------------- |
| `atproto-sync`      | enumerate → sync-repo × N → finalize | Sweeps the atproto network into the recipe index                |
| `recipe-enrichment` | enrich → llm-enrich                  | Derives allergen and diet labels, then a model's second opinion |
| `demo`              | start → task × N → report            | No-op fan-out — proves the whole path is wired                  |

`atproto-sync` is the whole of the old `@buttery/atproto-cron-sync` package:
`lib/sweep.ts` and the modules it reads the network with live in that folder now,
and `services/pipeline/.env` is the one file that says which atmosphere gets
swept. `enumerate` finds the repos and fans them out; each repo is a job of its
own; `finalize` folds what they returned into the `atproto_sync_run` row.
`recipe-enrichment` has two steps: `enrich` is the entry step, enqueued by
whoever just wrote the recipe — the app's save and import paths, and
`atproto-sync`'s `sync-repo` for a synced record whose content advanced. It
best-effort enqueues `llm-enrich` on success, for a model's second opinion;
that step is flag-gated and fails closed. Reprocessing the corpus is not a
step — there is no schedule and no boot-time re-enqueue — it is a CLI script:

```bash
pnpm --filter @buttery/pipeline backfill [--llm] [--limit=N] [--force] [--local-only]
```

`enrich` marks `recipe_enrichment.status = 'stale'` inside its own transaction
and only then enqueues `llm-enrich`. The row is the durable signal and the job
is the latency optimisation, so a Redis that is down costs freshness rather
than correctness: anything the enqueue dropped is still `stale`, and the
backfill script is what finds it.

`GET /workflows` reports the same table off the live registry.

## Schedules

A workflow that should run on a clock declares `schedule: () => pattern`, read
from the environment at boot. `atproto-sync` reads `ATPROTO_SYNC_SCHEDULE`:
`0 * * * *` on Railway, blank locally, because a laptop should not quietly sweep
the live atmosphere in the background.

The server reconciles those declarations into BullMQ **job schedulers** at boot —
one durable Redis record that produces the next job on a cron pattern, kept
running by whichever worker is around. That is what makes "run this hourly" a
property of the queue rather than of a container that has to stay up, and it is
why the sweep no longer needs a Railway cron service.

Reconcile, not register: schedulers outlive deployments, so a workflow whose
schedule was removed has its scheduler **deleted**. Emptying the variable
actually turns the schedule off instead of orphaning a job that keeps firing
from a config nothing in the repo mentions any more. The server does this because
it is the one process there is exactly one of; workers would race on every
scale-up.

Everything is UTC. A schedule that quietly shifts twice a year with a container's
local DST is its own kind of bug.

A schedule fires the graph's **entry** step, and the rest follows from there.
Overlap between one firing and the last is covered above.

## Autoscaling

Railway has no built-in autoscaler. It grows each container's CPU and memory
toward the plan limits on its own, but the **replica count is a setting you own**
and it stays where you put it. Railway's documented pattern for worker services
is to run a small process that measures load and moves `numReplicas` through the
Public API — that is [`src/autoscale.ts`](src/autoscale.ts), running inside the
`pipeline` server because everything it needs (queue handles, Redis, a process
that is always up) is already there.

The load signal is **queue depth**: `waiting + active`, summed across every
workflow. Fanning out is what makes that signal mean something: a sweep is
thousands of repo jobs waiting, which is a backlog the autoscaler can act on,
where one monolithic sweep job would have been a backlog of 1. Delayed jobs are excluded — a job scheduled for 3am is not work the
fleet can do now, and counting it would hold replicas open all night.

```
desired = clamp(ceil(pending / AUTOSCALE_BACKLOG_PER_REPLICA), min, max)
```

Scale-ups apply immediately; scale-downs wait out
`AUTOSCALE_SCALE_DOWN_COOLDOWN_SECONDS`. The asymmetry is the point — being a
replica short costs latency on a visible backlog, being a replica long costs a
few minutes of a container that was already running, and a symmetric policy flaps
between the two on every burst.

The loop is opt-in: no `RAILWAY_API_TOKEN`, no loop. It never runs locally.

| Variable                                | Default           | Meaning                                                        |
| --------------------------------------- | ----------------- | -------------------------------------------------------------- |
| `RAILWAY_API_TOKEN`                     | —                 | Project token. Absent ⇒ autoscaling is off entirely.           |
| `AUTOSCALE_TARGET_SERVICE`              | `pipeline-worker` | Service to scale, by name — resolved to an id via the API.     |
| `AUTOSCALE_TARGET_SERVICE_ID`           | —                 | Skips name resolution when the id is known.                    |
| `AUTOSCALE_MIN_REPLICAS`                | `1`               | Floor. Never scales below it, however empty the queues are.    |
| `AUTOSCALE_MAX_REPLICAS`                | `5`               | Ceiling. Railway's own hard cap is 50 across all regions.      |
| `AUTOSCALE_BACKLOG_PER_REPLICA`         | `25`              | Pending jobs one replica is expected to absorb.                |
| `AUTOSCALE_INTERVAL_SECONDS`            | `60`              | How often to evaluate.                                         |
| `AUTOSCALE_SCALE_DOWN_COOLDOWN_SECONDS` | `300`             | Quiet period between scale-downs.                              |
| `AUTOSCALE_DRY_RUN`                     | `false`           | Decide and log, never call the mutation. Good for a first run. |

`RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID` and `RAILWAY_REPLICA_ID` are
injected by Railway; nothing configures them.

Concurrency and replicas are **different dials**. `PIPELINE_WORKER_CONCURRENCY`
is how many jobs one process interleaves — right for I/O-bound work, useless for
CPU-bound work, since it is all one event loop. Replicas add actual CPUs. Raise
concurrency first for a workflow that mostly waits on the network; raise replicas
for one that mostly computes. A workflow's `globalConcurrency` is the third and
it caps both: see [One job per step](#one-job-per-step) above.

## Local development

Both processes boot with `pnpm dev` (see
[`process-compose.yaml`](../../process-compose.yaml)). The board is at
<http://127.0.0.1:3002/ui>.

```bash
# Fan out four demo tasks and watch the graph move through the board.
curl -X POST http://127.0.0.1:3002/jobs/demo \
  -H 'content-type: application/json' \
  -d '{"data": {"tasks": 4, "durationMs": 1500, "label": "hello"}}'

# Make every task fail, to watch the retries and then `report` count them
# rather than fail with them.
curl -X POST http://127.0.0.1:3002/jobs/demo \
  -H 'content-type: application/json' \
  -d '{"data": {"tasks": 3, "fail": true}}'

# Run several workers against one queue, the way replicas do on Railway.
process-compose process scale pipeline-worker 3

# Run a workflow without the queue at all — same steps, logs to the terminal.
pnpm --filter @buttery/pipeline sync:once --dry-run
pnpm --filter @buttery/pipeline run:once demo --label=hello
```

`run:once` turns flags into the entry step's payload (`--dry-run` is
`{"dryRun": true}`, `--max-repos=25` is `{"maxRepos": "25"}`) and goes through the
same `Workflow.run` the worker does, so a run by hand and a queued run cannot
drift. Fanning out has nowhere to fan out _to_, so the children run in that same
process — which is the one honest difference between the two: a queue is how work
reaches other machines, and a shell command has no other machines. It is also how
the disabled `atproto-sync` process-compose one-shot runs.

Config lives in `services/pipeline/.env`, created from `.env.example` by
`pnpm dev` when missing — one file for the queue system and for the workflows,
including which atproto network a sweep reads. Queue state lives in the dev
Redis; `docker compose down -v` wipes it.

`pnpm --filter @buttery/pipeline test` covers the graph kernel, the summary
folding, the scaling policy, the backlog arithmetic and the sweep's rendering — all pure, so no Redis and no
database are required. `test:db` adds the render suite against a real migrated
Postgres, and skips itself when there is not one.
