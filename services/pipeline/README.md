# `@buttery/pipeline`

Buttery's data pipelines: a [BullMQ](https://docs.bullmq.io) job system on Redis,
a [Fastify](https://fastify.dev) server hosting the
[Bull Board](https://github.com/felixmosh/bull-board) UI, and a worker fleet that
Railway autoscales on queue depth.

One package, three entrypoints — two deployed, one for a shell:

| Process                             | Entrypoint           | What it is                                                          |
| ----------------------------------- | -------------------- | ------------------------------------------------------------------- |
| `pipeline` (Railway service)        | `src/server.ts`      | Producer + Bull Board UI + the autoscaler loop. Never runs a job.   |
| `pipeline-worker` (Railway service) | `src/worker.ts`      | One `Worker` per queue. No HTTP, no state — safe to add and remove. |
| `trigger` / `sync:trigger`          | `src/cli/trigger.ts` | Adds one job to a queue and exits. Runs nothing itself.             |

They are split because the two things scale for different reasons. The board has
to be up whenever someone wants to look at it, and exactly one of it is enough;
the fleet needs to grow with the backlog and shrink when it drains. Deploying
them as one service would tie a dashboard restart to a scaling event, and a
scaling event to a dashboard restart.

## Routes

`GET /health` is unauthenticated — Railway's healthcheck has no credentials.
Everything else sits behind HTTP basic auth (`PIPELINE_AUTH_USER` /
`PIPELINE_AUTH_PASSWORD`):

| Route               | What it does                                            |
| ------------------- | ------------------------------------------------------- |
| `GET /health`       | Liveness, plus the queue names this build knows about   |
| `GET /ui`           | Bull Board                                              |
| `GET /queues`       | Every registered queue — its jobs, schedule and backlog |
| `GET /autoscale`    | The autoscaler's last decision, or `{"enabled": false}` |
| `POST /jobs/:queue` | Enqueue one job: `{"name"?: string, "data"?: unknown}`  |

The board is not read-only — it shows every job payload and lets a visitor
retry, promote and delete jobs — so `PIPELINE_AUTH_PASSWORD` is **required** when
`NODE_ENV=production` and the service refuses to start without it. Locally the
password is blank and there is no login prompt; the whole dev stack is
loopback-only.

## Queues, workers and flows

There is no workflow engine here. The three things this service is built out of
are [BullMQ](https://docs.bullmq.io)'s own top-level primitives, under their own
names:

- a **[Queue](https://docs.bullmq.io/guide/queues)** is a named list of jobs, and
  the unit everything else is organised around;
- a **[Worker](https://docs.bullmq.io/guide/workers)** drains one queue with one
  processor function;
- a **[Flow](https://docs.bullmq.io/guide/flows)** is a parent job and the
  children that must finish before it runs.

There used to be a `defineWorkflow` kernel on top of these — a `WorkflowSpec` of
named `StepSpec`s, a `StepContext` handed to each one, and two `WorkflowHost`
implementations. It is gone, and the reason is worth keeping: it renamed every
BullMQ concept on the way through. A job was a "step", a queue was a "workflow",
`FlowProducer.add` was `ctx.flow`, `queue.add` on another queue was
`ctx.enqueue`. Reading BullMQ's documentation did not help you read this
codebase, and a step that wanted something the kernel had not thought to forward
— `job.attemptsMade`, `job.discard()`, `UnrecoverableError` semantics — had to
grow the kernel first.

So a job is a job. A processor receives the real `Job` and calls `job.log()`,
`job.updateProgress()`, `job.getChildrenValues()` — BullMQ's own API, documented
by BullMQ.

### Registering one

Each queue is a Fastify plugin in one folder under `src/queues/`:

```
src/queues/
  demo/index.ts         the smallest complete example, in one file
  atproto-sync/         a queue with real code: jobs.ts, plan.ts, types.ts, lib/
  recipe-enrichment/    the second one: index.ts, types.ts, lib/
```

```ts
// src/queues/my-thing/index.ts
export default fp(
  (fastify) => {
    const queue = fastify.bullmq.queue({
      name: "my-thing",
      description: "One line, shown in /queues and on the board",
      jobs: [
        { name: FETCH_JOB, description: "Find the work and fan it out" },
        { name: TRANSFORM_JOB, description: "One item" },
        { name: WRITE_JOB, description: "Fold what the children returned" },
      ],
      defaultJob: FETCH_JOB,
    });

    // One processor per queue. Which job it is, is `job.name` — the idiomatic
    // BullMQ way to run several kinds of work on one queue.
    fastify.bullmq.worker("my-thing", async (job) => {
      switch (job.name) {
        case FETCH_JOB:
          return fetchIt(fastify, job);
        case TRANSFORM_JOB:
          return transformOne(fastify, job);
        case WRITE_JOB:
          return writeAll(fastify, job);
        default:
          throw new UnrecoverableError(`unknown job "${job.name}"`);
      }
    });
  },
  { name: "queue-my-thing", dependencies: ["bullmq", "db"] },
);
```

There is nothing to add it to. `src/app.ts` autoloads every
`src/queues/*/index.ts`, so the file existing is the registration: the board
lists it, `POST /jobs/my-thing` works, the worker builds a `Worker` for it, and
the autoscaler starts counting its backlog.

`plugins/bullmq.ts` is deliberately thin. It owns three things and no more:
**lifecycle** (queues, workers and the flow producer are closed in the right
order by `preClose` and `onClose`, before Redis goes away underneath them),
**role** (only a `worker` process constructs `Worker`s — BullMQ has no
create-then-start split, so constructing one _is_ starting to consume — and only
the `server` reconciles schedulers and concurrency caps), and **a registry**,
because the board, `GET /queues` and `POST /jobs/:queue` all need to enumerate
what exists.

Handlers reach dependencies through the enclosing plugin's `fastify` —
`fastify.db`, `fastify.redis`, `fastify.posthog`, `fastify.ai` — rather than
constructing their own. Whatever a handler touches goes in the `dependencies`
array, and the plugin owning a resource closes it on shutdown, so a queue has no
teardown of its own to write.

### One job per unit of work

Every job is its own unit of:

- **retry** — a job carries its own `attempts` and backoff, passed at
  `queue.add` time, so a repo whose PDS times out costs that repo its retries and
  nobody else's work;
- **failure** — a child that exhausts its attempts is stepped over and _counted_
  by its parent, instead of taking the whole run down;
- **distribution** — every job goes through the queue, so the fleet shares them
  instead of one worker looping alone; and
- **visibility** — the board shows each one with its own payload, log, duration,
  return value and place in the tree.

A parent waiting on children occupies no worker while it waits, which is what
makes fanning a sweep out over thousands of repos reasonable rather than a way to
pin a process for an hour.

Job options are now passed **explicitly at every `queue.add`**. The old kernel
applied a step's `jobOptions` automatically at enqueue time; nothing does that
now, because a `Queue` is just a `Queue`. Each queue exports its options as named
constants next to the handler they belong to. `POST /jobs/:queue` is the one
caller that cannot reach them and falls back to the queue's
`defaultJobOptions` — a deliberate difference, called out where it happens.

### Fanning out, and how many run at once

`fastify.bullmq.flow.add(node)` submits a parent and everything that must finish
first, in one atomic call, so there is never a window where half a fan-out
exists. Every node names both its `name` and its `queueName`.

Children must set **`ignoreDependencyOnFailure: true` explicitly**. That is what
"counted, not fatal" means — a child that fails for good leaves the parent's
dependencies instead of failing it — and it is _not_ a BullMQ default. The old
kernel set it on every child automatically, so this is the one place where
deleting the engine moved a guarantee from the framework into the call sites. A
parent that wants the opposite says `failParentOnFailure: true`.

Handing work to another queue is `queue.add` on that queue, reached through
`fastify.bullmq.get(name)`. It is not a flow, and it must not be: a flow child is
something the calling tree's parent waits on, so `atproto-sync`'s `finalize`
would sit in `waiting-children` until every enrichment it triggered had finished
— holding the sweep's hour-TTL lock the whole time, and skipping the next
scheduled sweep. Handing a job to _your own_ queue is just `queue.add` on the
queue you already registered; the old engine had no way to say that, which is why
the `enrich → llm-enrich` handoff used to look like a cross-workflow call.

**Nothing throttles the producer.** A job fans out everything it has and the
queue holds it — a queue that is a buffer is the point of having one. How many
actually run is `globalConcurrency`, a cap BullMQ enforces in Redis across every
worker there is:

| Limit                          | Bounds                             | Set by                          |
| ------------------------------ | ---------------------------------- | ------------------------------- |
| `PIPELINE_WORKER_CONCURRENCY`  | one process                        | the environment, per service    |
| `globalConcurrency` on a queue | the whole fleet, however it scales | the queue, from the environment |

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
registered, so a queue that stops declaring a cap has it removed.

### Overlap

BullMQ stops the same job running twice; it does not stop two _different_ jobs on
a queue, which is exactly what an hourly schedule plus a sweep that runs long
produces. The Railway cron this replaced got that from the platform, so losing it
would be a regression.

`atproto-sync` takes a Redis mutex ([`src/lib/lock.ts`](src/lib/lock.ts)) in `enumerate`
and releases it in `finalize` — so it spans the whole graph, not one job. A sweep
that cannot take it **skips**: it completes with `{"status": "skipped"}` rather
than failing, because the work is already being done and failing would only buy a
retry that hits the same lock. A sweep triggered by hand goes through the same
queue as a scheduled one, so it takes the same lock too.

Nothing heartbeats the lock — the holder is a graph, not a process — so the TTL is
a plain deadline, set to the schedule's own period. What it promises is "a sweep
may not start while the last one is still going, up to one period", and freeing it
then beats wedging the schedule forever if `finalize` never runs.

Set `removeOnComplete` / `removeOnFail` on every queue's `defaultJobOptions`, and
on any job that needs its own. BullMQ keeps finished jobs in Redis forever by
default, and a fanned-out flow produces a job per item, so an unbounded queue
becomes the largest thing in the instance faster than you would expect.

## The queues

| Queue               | Jobs                                 | What it does                                                    |
| ------------------- | ------------------------------------ | --------------------------------------------------------------- |
| `atproto-sync`      | enumerate → sync-repo × N → finalize | Sweeps the atproto network into the recipe index                |
| `recipe-enrichment` | enrich → llm-enrich                  | Derives allergen and diet labels, then a model's second opinion |
| `demo`              | start → task × N → report            | No-op fan-out — proves the whole path is wired                  |

`atproto-sync` is the whole of the old `@buttery/atproto-cron-sync` package:
`lib/sweep.ts` and the modules it reads the network with live in that folder now,
and `services/pipeline/.env` is the one file that says which atmosphere gets
swept. `enumerate` finds the repos and fans them out; each repo is a job of its
own; `finalize` folds what they returned into the `atproto_sync_run` row.
`recipe-enrichment` has two jobs: `enrich` is the default one, enqueued by
whoever just wrote the recipe — the app's save and import paths, and
`atproto-sync`'s `sync-repo` for a synced record whose content advanced. It
best-effort adds an `llm-enrich` job on success, for a model's second opinion;
that one is flag-gated and fails closed. Reprocessing the corpus is not a
job on this queue — there is no schedule and no boot-time re-enqueue — it is a
CLI script:

```bash
pnpm --filter @buttery/pipeline backfill [--llm] [--limit=N] [--force] [--local-only]
```

`enrich` marks `recipe_enrichment.status = 'stale'` inside its own transaction
and only then enqueues `llm-enrich`. The row is the durable signal and the job
is the latency optimisation, so a Redis that is down costs freshness rather
than correctness: anything the enqueue dropped is still `stale`, and the
backfill script is what finds it.

`GET /queues` reports the same table off the live registry, with backlog counts.

## Schedules

A queue that should run on a clock declares `schedule: pattern`, read from
`fastify.env` at registration. `atproto-sync` reads `ATPROTO_SYNC_SCHEDULE`:
`0 * * * *` on Railway, blank locally, because a laptop should not quietly sweep
the live atmosphere in the background.

The server reconciles those declarations into BullMQ **job schedulers** at boot —
one durable Redis record that produces the next job on a cron pattern, kept
running by whichever worker is around. That is what makes "run this hourly" a
property of the queue rather than of a container that has to stay up, and it is
why the sweep no longer needs a Railway cron service.

Reconcile, not register: schedulers outlive deployments, so a queue whose
schedule was removed has its scheduler **deleted**. Emptying the variable
actually turns the schedule off instead of orphaning a job that keeps firing
from a config nothing in the repo mentions any more. The server does this because
it is the one process there is exactly one of; workers would race on every
scale-up.

Everything is UTC. A schedule that quietly shifts twice a year with a container's
local DST is its own kind of bug.

A schedule adds the queue's **`defaultJob`**, and the rest follows from there.
Overlap between one firing and the last is covered above.

## Autoscaling

Railway has no built-in autoscaler. It grows each container's CPU and memory
toward the plan limits on its own, but the **replica count is a setting you own**
and it stays where you put it. Railway's documented pattern for worker services
is to run a small process that measures load and moves `numReplicas` through the
Public API — that is [`src/lib/railway/autoscale.ts`](src/lib/railway/autoscale.ts), running inside the
`pipeline` server because everything it needs (queue handles, Redis, a process
that is always up) is already there.

The load signal is **queue depth**: `waiting + active`, summed across every
queue. Fanning out is what makes that signal mean something: a sweep is
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
concurrency first for a queue that mostly waits on the network; raise replicas
for one that mostly computes. A queue's `globalConcurrency` is the third and it
caps both: see [One job per unit of work](#one-job-per-unit-of-work) above.

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

# Add a job from a shell, then watch it run on the fleet in the board.
pnpm --filter @buttery/pipeline sync:trigger --dry-run
pnpm --filter @buttery/pipeline trigger demo --label=hello
pnpm --filter @buttery/pipeline trigger recipe-enrichment --job=llm-enrich --recipe-id=<id>
```

`trigger` turns flags into the job's payload (`--dry-run` is `{"dryRun": true}`,
`--max-repos=25` is `{"maxRepos": "25"}`), validates `--job=` against the queue's
registered job names, calls `queue.add` and exits. It **runs nothing itself** —
it assumes a server and a worker are already up, and the work happens on the
fleet where you can watch it in the board.

That is a deliberate change from the `run:once` it replaced, which executed a
whole graph in-process through a console host that re-implemented fan-out. Two
execution engines meant the path a developer iterated on was not the path
production ran, and a graph that only broke in one of them was a graph nobody had
tested in production shape. The cost is that the CLI now needs the stack up; the
gain is that it cannot drift from the queue that actually runs the work, because
it _is_ that queue.

Config lives in `services/pipeline/.env`, created from `.env.example` by
`pnpm dev` when missing — one file for the queue system and for the queues,
including which atproto network a sweep reads. Queue state lives in the dev
Redis; `docker compose down -v` wipes it.

`pnpm --filter @buttery/pipeline test` covers the job handlers, the summary
folding, the scaling policy, the backlog arithmetic and the sweep's rendering —
all pure, so no Redis and no database are required. `test:db` adds the render suite against a real migrated
Postgres, and skips itself when there is not one.
