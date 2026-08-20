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

A **workflow** is one queue plus an ordered list of **steps** that drain it, and
it lives in one folder under `src/workflows/`:

```
src/workflows/
  define.ts             the kernel: what a workflow is, and what running one means
  hosts.ts              where a run reports to — a BullMQ job, or a terminal
  index.ts              the registry: WORKFLOWS
  demo/index.ts         the reference implementation, in one file
  atproto-sync/         a workflow with real code: index.ts, steps.ts, and the rest
```

```ts
// src/workflows/my-thing/index.ts
export const myThing = defineWorkflow<MyState>({
  name: "my-thing",
  description: "One line, shown in /workflows and /queues",
  start: (payload) => ({ …parse(payload) }),
  steps: [fetchIt, transformIt, writeIt],
  result: (state) => state.summary,
  defaultJobOptions: { attempts: 3, removeOnComplete: { count: 50 } },
});
```

Add it to `WORKFLOWS` in [`src/workflows/index.ts`](src/workflows/index.ts) and
you are done: the server builds a `Queue` so the board lists it and
`POST /jobs/my-thing` works, the worker builds a `Worker` for it, the autoscaler
starts counting its backlog, and `run:once my-thing` runs it from a shell.
Nothing else in the service is queue-aware.

### Why steps

Steps are BullMQ's own vocabulary — the library's documented pattern for a job
with phases is a cursor in the job's data and a switch on it.
[`define.ts`](src/workflows/define.ts) is that pattern with the bookkeeping
factored out, so a workflow file holds the work and nothing else. What you get:

- **A job stops being opaque.** The board shows which of five named phases a
  sweep is in, how long each took, and which one a failure came out of.
- **Progress is real.** The kernel advances the job across the steps and scales
  whatever a step reports within its own slice, so the bar means something
  without a workflow computing percentages.
- **A retry can resume**, if the workflow says so — see below.

`start` is where a workflow parses its payload: a payload is whatever JSON was in
Redis, possibly enqueued by an older deployment, so it is narrowed once, up
front, rather than trusted through a generic that proves nothing at runtime.

This is not a BullMQ **flow** (`FlowProducer`, parent/child jobs). A flow is
right for fan-out where each child deserves its own job, retry and place in the
backlog. The steps of one sweep are none of those — strictly sequential, sharing
an in-memory context — and turning the per-repo loop into thousands of child jobs
would multiply Redis traffic and drown the autoscaler's queue-depth signal in
bookkeeping.

### Resuming

`resumeOnRetry` makes a retry pick up at the step the last attempt died on. It is
**off by default**, and the default is the safe one: `state` is rebuilt by
`start()` on every attempt, so resuming skips the steps that would have filled it
in. Only turn it on when every step can work from `start()`'s state plus whatever
earlier steps wrote somewhere durable.

`demo` is on, and shows what it buys: a `fail: true` job's second attempt skips
the sleeps and fails in milliseconds. `atproto-sync` is off, because `index`
needs the DID list `enumerate` built and that list runs to thousands of entries —
which have no business round-tripping through Redis on every step boundary.
Restarting a sweep is cheap anyway: every write in it is a rev-guarded idempotent
upsert.

### Two other things worth declaring

`exclusive: { key, ttlMs }` holds a Redis mutex for the length of a run,
fleet-wide. A run that cannot take it **skips** — completes with
`{"status": "skipped"}` rather than failing, because the work is already being
done and failing would only buy a retry that hits the same lock.

`onFailure` runs when a step throws, before the error propagates: for finalizing
whatever earlier steps opened. `atproto-sync` uses it to mark its
`atproto_sync_run` row failed, so a sweep that dies mid-flight does not leave a
row saying `running` forever.

Set `defaultJobOptions.removeOnComplete` / `removeOnFail` on every workflow.
BullMQ keeps finished jobs in Redis forever by default, and an unbounded queue
quietly becomes the largest thing in the instance.

## The workflows

| Queue          | Steps                                                | What it does                                      |
| -------------- | ---------------------------------------------------- | ------------------------------------------------- |
| `atproto-sync` | enumerate → open-run → index → reconcile → close-run | Sweeps the atproto network into the recipe index  |
| `demo`         | warm-up → work → finish                              | No-op — proves queue, workers and board are wired |

`atproto-sync` is the whole of the old `@buttery/atproto-cron-sync` package:
`sweep.ts` and the modules it reads the network with live in that folder now, and
`services/pipeline/.env` is the one file that says which atmosphere gets swept.
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

**Overlap.** BullMQ stops the same job running twice, not two different jobs on
one queue — which is exactly what an hourly schedule plus a sweep that runs long
plus two replicas produces. The Railway cron this replaced got that guarantee
from the platform, so `atproto-sync` declares `exclusive` and takes a Redis mutex
([`src/lock.ts`](src/lock.ts)). `sync:once` takes the same lock: a sweep started
by hand must not run alongside a scheduled one just because a person started it.

## Autoscaling

Railway has no built-in autoscaler. It grows each container's CPU and memory
toward the plan limits on its own, but the **replica count is a setting you own**
and it stays where you put it. Railway's documented pattern for worker services
is to run a small process that measures load and moves `numReplicas` through the
Public API — that is [`src/autoscale.ts`](src/autoscale.ts), running inside the
`pipeline` server because everything it needs (queue handles, Redis, a process
that is always up) is already there.

The load signal is **queue depth**: `waiting + active`, summed across every
workflow. Delayed jobs are excluded — a job scheduled for 3am is not work the
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

# Run a workflow without the queue at all — same steps, logs to the terminal.
pnpm --filter @buttery/pipeline sync:once --dry-run
pnpm --filter @buttery/pipeline run:once demo --label=hello
```

`run:once` turns flags into the job payload (`--dry-run` is `{"dryRun": true}`,
`--label=hello` is `{"label": "hello"}`) and goes through the same
`Workflow.run` the worker does, so a run by hand and a queued run cannot drift.
It is also how the disabled `atproto-sync` process-compose one-shot runs.

Config lives in `services/pipeline/.env`, created from `.env.example` by
`pnpm dev` when missing — one file for the queue system and for the workflows,
including which atproto network a sweep reads. Queue state lives in the dev
Redis; `docker compose down -v` wipes it.

`pnpm --filter @buttery/pipeline test` covers the step kernel, the scaling policy,
the backlog arithmetic and the sweep's rendering — all pure, so no Redis and no
database are required. `test:db` adds the render suite against a real migrated
Postgres, and skips itself when there is not one.
