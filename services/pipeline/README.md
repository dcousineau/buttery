# `@buttery/pipeline`

Buttery's data pipelines: a [BullMQ](https://docs.bullmq.io) job system on Redis,
a [Fastify](https://fastify.dev) server hosting the
[Bull Board](https://github.com/felixmosh/bull-board) UI, and a worker fleet that
Railway autoscales on queue depth.

One package, two processes:

| Process                             | Entrypoint      | What it is                                                          |
| ----------------------------------- | --------------- | ------------------------------------------------------------------- |
| `pipeline` (Railway service)        | `src/server.ts` | Producer + Bull Board UI + the autoscaler loop. Never runs a job.   |
| `pipeline-worker` (Railway service) | `src/worker.ts` | One `Worker` per queue. No HTTP, no state — safe to add and remove. |

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
| `GET /queues`       | Job counts per queue as JSON                            |
| `GET /autoscale`    | The autoscaler's last decision, or `{"enabled": false}` |
| `POST /jobs/:queue` | Enqueue one job: `{"name"?: string, "data"?: unknown}`  |

The board is not read-only — it shows every job payload and lets a visitor
retry, promote and delete jobs — so `PIPELINE_AUTH_PASSWORD` is **required** when
`NODE_ENV=production` and the service refuses to start without it. Locally the
password is blank and there is no login prompt; the whole dev stack is
loopback-only.

## Adding a pipeline

A pipeline is one queue plus the function that drains it, declared together:

```ts
// src/jobs/my-thing.ts
export const myThingPipeline: PipelineDefinition = {
  name: "my-thing",
  description: "One line, shown in /queues",
  defaultJobOptions: { attempts: 3, removeOnComplete: { count: 50 } },
  process: async (job) => {
    /* … */
  },
};
```

Add it to `PIPELINES` in [`src/jobs/index.ts`](src/jobs/index.ts) and you are
done: the server builds a `Queue` for it so the board lists it and
`POST /jobs/my-thing` works, the worker builds a `Worker` for it, and the
autoscaler starts counting its backlog. Nothing else in the service is
queue-aware.

`process` receives an unparameterized `Job`, deliberately. A payload is whatever
JSON was in Redis — possibly enqueued by an older deployment — so handlers narrow
`job.data` themselves rather than trusting a generic that proves nothing at
runtime. See [`src/jobs/demo.ts`](src/jobs/demo.ts) for the shape.

Set `defaultJobOptions.removeOnComplete` / `removeOnFail` on every pipeline.
BullMQ keeps finished jobs in Redis forever by default, and an unbounded queue
quietly becomes the largest thing in the instance.

## The pipelines

| Queue          | What it does                                                                   |
| -------------- | ------------------------------------------------------------------------------ |
| `atproto-sync` | Sweeps the atproto network and reconciles the Postgres recipe index. Hourly.   |
| `demo`         | No-op with progress reporting — proves the queue, workers and board are wired. |

`atproto-sync` runs the sweep from
[`@buttery/atproto-cron-sync`](../atproto-cron-sync/README.md) — it schedules and
supervises that code, it does not reimplement it, and the sweep still reads its
own `.env` for which network to read. That package's `sync:once` CLI is still
there for running one by hand.

## Schedules

A pipeline that should run on a clock declares `schedule: () => pattern`, read
from the environment at boot. `atproto-sync` reads `ATPROTO_SYNC_SCHEDULE`:
`0 * * * *` on Railway, blank locally, because a laptop should not quietly sweep
the live atmosphere in the background.

The server reconciles those declarations into BullMQ **job schedulers** at boot —
one durable Redis record that produces the next job on a cron pattern, kept
running by whichever worker is around. That is what makes "run this hourly" a
property of the queue rather than of a container that has to stay up, and it is
why the sweep no longer needs a Railway cron service.

Reconcile, not register: schedulers outlive deployments, so a pipeline whose
schedule was removed has its scheduler **deleted**. Emptying the variable
actually turns the schedule off instead of orphaning a job that keeps firing
from a config nothing in the repo mentions any more. The server does this because
it is the one process there is exactly one of; workers would race on every
scale-up.

Everything is UTC. A schedule that quietly shifts twice a year with a container's
local DST is its own kind of bug.

**Overlap.** BullMQ stops the same job running twice, not two different jobs on
one queue — which is exactly what an hourly schedule plus a sweep that runs long
plus two replicas produces. The Railway cron this replaced got that guarantee
from the platform, so `atproto-sync` takes a Redis mutex ([`src/lock.ts`](src/lock.ts))
and a second sweep skips rather than fails: the work is already being done, and
failing would only buy a retry that hits the same lock.

## Autoscaling

Railway has no built-in autoscaler. It grows each container's CPU and memory
toward the plan limits on its own, but the **replica count is a setting you own**
and it stays where you put it. Railway's documented pattern for worker services
is to run a small process that measures load and moves `numReplicas` through the
Public API — that is [`src/autoscale.ts`](src/autoscale.ts), running inside the
`pipeline` server because everything it needs (queue handles, Redis, a process
that is always up) is already there.

The load signal is **queue depth**: `waiting + active`, summed across every
pipeline. Delayed jobs are excluded — a job scheduled for 3am is not work the
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
concurrency first for a pipeline that mostly waits on the network; raise replicas
for one that mostly computes.

## Local development

Both processes boot with `pnpm dev` (see
[`process-compose.yaml`](../../process-compose.yaml)). The board is at
<http://127.0.0.1:3002/ui>.

```bash
# Enqueue a demo job and watch it move through the board.
curl -X POST http://127.0.0.1:3002/jobs/demo \
  -H 'content-type: application/json' \
  -d '{"data": {"durationMs": 5000, "label": "hello"}}'

# Make one fail, to exercise retries and the board's failed tab.
curl -X POST http://127.0.0.1:3002/jobs/demo \
  -H 'content-type: application/json' \
  -d '{"data": {"fail": true}}'

# Run several workers against one queue, the way replicas do on Railway.
process-compose process scale pipeline-worker 3
```

Config lives in `services/pipeline/.env`, created from `.env.example` by
`pnpm dev` when missing. Queue state lives in the dev Redis; `docker compose
down -v` wipes it.

`pnpm --filter @buttery/pipeline test` covers the scaling policy and the backlog
arithmetic — both pure functions, so no Redis is required.
