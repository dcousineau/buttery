# `@buttery/worker`

Buttery's background work, as [Temporal](https://temporal.io) workflows: durable
executions that survive the process running them.

Today that is one real workflow — the hourly atproto sweep — plus a reference
workflow that exists to be watched. The shape is chosen for what comes next: a
pipeline per recipe write (rendered tags, derived data, an LLM pass) and
publishing, both of which are long, multi-step, partly-third-party, and
unpleasant to make correct with retries alone.

## What is in the package

| Path                    | What it is                                                               |
| ----------------------- | ------------------------------------------------------------------------ |
| `src/worker.ts`         | The service. Polls one task queue, runs everything below.                |
| `src/workflows.ts`      | The workflow bundle — every workflow, under the name it is started by    |
| `src/activities.ts`     | Every activity, built over the dependencies `worker.ts` owns             |
| `src/schedules.ts`      | The schedules this build wants, and the reconcile that applies them      |
| `src/schedules-sync.ts` | Entrypoint for that reconcile. Railway `preDeploy`, and a local one-shot |
| `src/config.ts`         | The environment: where the cluster is, how big this process may get      |

There is no producer service, no dashboard, and no CLI of our own. Starting a
workflow is `temporal workflow start` (or a client call from anywhere with the
address); watching one is the Temporal UI.

## A workflow is a folder

```
src/workflows/atproto-sync/
  workflow.ts    the entrypoint, in the sandbox: orchestration and nothing else
  plan.ts        pure helpers it calls — batching, folding counters
  activities.ts  the activity entrypoints: thin wrappers, the retry boundaries
  types.ts       what the two sides exchange
  lib/           what the work actually is: pg, fetch, atproto
```

| File                     | Runs where                     | May touch                               |
| ------------------------ | ------------------------------ | --------------------------------------- |
| `workflow.ts`, `plan.ts` | The deterministic sandbox      | Nothing. No `process`, no clock, no I/O |
| `activities.ts`, `lib/`  | Plain Node, inside an activity | Everything                              |
| `types.ts`               | Both, types only               | Nothing — it is the wire format         |

Adding one is a folder plus a line in `src/workflows.ts` and a line in
`src/activities.ts`.

### The two rules types don't catch

**Workflow code must stay sandbox-safe.** `workflow.ts` may import `types.ts`,
`plan.ts`, and `activities.ts` _for its types only_ — reaching into `lib/` from a
workflow is the mistake this layout exists to prevent, because it fails at
runtime on a deployed worker rather than in an editor. `workflows.test.ts` builds
the bundle exactly as the worker does at boot, so it is a red test instead.

**The export name in `src/workflows.ts` is the workflow type.** That string is
what `temporal workflow start --type atprotoSync` sends and what the worker looks
up. A mismatch produces a workflow that starts happily and then fails every task
with `no such function is exported by the workflow bundle`; the same test asserts
the names.

### Arguments vs environment

The split the whole service holds to:

- **The environment** says what this deployment is — which cluster, which relay,
  which PDS, how big this worker may get. `config.ts` and `lib/config.ts`, read
  inside activities only. A workflow that read `process.env` would be
  non-deterministic on replay.
- **A workflow argument** says what one run should do differently — `dryRun`,
  `maxRepos`, `onlyDid`, `parallelism`. One JSON object, typed in `types.ts`, and
  every field optional with an environment fallback.

```bash
temporal workflow execute --type atprotoSync --task-queue buttery \
  --workflow-id atproto-sync --input '{"dryRun":true,"maxRepos":25}'
```

## The atproto sweep

`enumerateRepos → openSyncRun → syncRepo × N → reconcileMissingRepos →
closeSyncRun`. Each `await` in `workflow.ts` is a point the run resumes from: a
worker that dies mid-sweep costs the repos in flight, not the hour.

**One repo is one activity**, which makes the repo the unit of three separate
things:

- **Retry.** A PDS that times out costs that repo three attempts, not everyone
  else's work. `sweepDid` throws rather than swallowing, because throwing is how
  an activity asks for the retry it deserves; the error still lands in
  `atproto_repo.last_error` on the way out.
- **Failure.** A repo that exhausts its retries is counted and stepped over, so
  one dead PDS never ends a sweep. An hourly sweep that failed whenever one of
  thousands of servers was unreachable would simply always be failing.
- **Distribution.** Repos go through the task queue, so a fleet shares them
  instead of one worker looping alone.

They run as a **rolling pool**: `parallelism` runners, each claiming the next
unclaimed DID the moment it finishes the last one. Nothing waits for a batch
boundary, so a slow PDS costs its own slot and nobody else's. Temporal has no
per-workflow concurrency limit to lean on here —
`WORKER_MAX_CONCURRENT_ACTIVITIES` bounds what one worker will _execute_ across
everything it is doing, which protects the machine but would not stop this sweep
from scheduling thousands of activities into its own history at once. The pool is
the scheduling-side half.

Two traps that loop has, both commented where they live: fold the result _after_
the await (`foldRepo(summary, await …)` reads `summary` before suspending, so two
runners lose one another's counts — it shipped that way for one commit and showed
up as a failure count of 1 where the history said 3), and let cancellation
through rather than counting it as a failed repo.

Timeouts are sized from a measured sweep of the live atmosphere: a healthy repo
is ~700 ms (p50) and ~1 s (p90), so `syncRepo` gets 45 s per attempt and a 90 s
`scheduleToCloseTimeout` as its total hang budget, and the HTTP layer's
per-request timeout is 8 s. A host that accepts connections and then hangs used
to cost 25 s per attempt; it now costs 16 s, and the sweep never waits on it.

What it costs is history — roughly three events per repo against a 10k-event
soft warning and a 50k hard cap. So the loop watches `continueAsNewSuggested` and
hands the remaining DIDs plus its cursor to a fresh execution when the server
says the history is getting long. That also bounds the other growth worth
watching: `dids` is carried in workflow state, so it is carried in the history,
at ~150 KB per few thousand DIDs against a 2 MB payload limit.

`continueAsNew` reports itself by throwing, which means the sweep's `catch` sees
it — and must let it through untouched, or a handover becomes a failure and the
run row gets closed under a sweep that is still going. That is the one piece of
Temporal trivia this file could not do without.

## Schedules

Schedules live in the cluster and outlive every deployment, so `schedules.ts`
**reconciles** rather than registers: anything in the namespace this build does
not declare is deleted. That is what makes emptying `ATPROTO_SYNC_SCHEDULE`
genuinely turn the sweep off, and it is safe because the namespace is ours.
Everything is UTC.

`schedules:sync` is a deploy step (Railway `preDeploy`), not a background loop —
once per deploy, in the built image, before any new container serves, and a
non-zero exit aborts the deploy.

Overlap is the schedule's `SKIP` policy: a firing that lands while the previous
run is still going is dropped. A run you start by hand takes the fixed workflow
id `atproto-sync`, which Temporal will not start twice concurrently; to get the
schedule's semantics as well, trigger the schedule rather than the workflow:

```bash
temporal schedule trigger --schedule-id atproto-sync --overlap-policy Skip
```

## Namespace

Everything is in the **`buttery`** namespace, not `default`. A namespace is
Temporal's isolation boundary — schedules, task queues, workflow ids and
retention all scope to one — so "every schedule here is ours" is a statement the
reconcile above can safely act on. It must exist before a worker connects: the
dev stack passes `--namespace buttery` to `start-dev`, and on Railway auto-setup
creates it from `DEFAULT_NAMESPACE`.

## Local dev

`pnpm dev` boots a local cluster and this worker beside the rest of the stack.

|               |                                                                |
| ------------- | -------------------------------------------------------------- |
| Temporal UI   | <http://127.0.0.1:8233>                                        |
| Temporal gRPC | `127.0.0.1:7233`                                               |
| History       | `.dev-data/temporal/dev.db` — survives restarts, `rm` to reset |

```bash
temporal workflow execute --type demo --task-queue buttery \
  --workflow-id demo-1 --input '{"label":"hello"}'
temporal workflow execute --type demo --task-queue buttery \
  --workflow-id demo-2 --input '{"fail":true}'          # a retry that resumes

process-compose process start atproto-sync              # one sweep, the same as the schedule runs
process-compose process scale worker 3                  # several workers, one task queue

temporal workflow list
temporal task-queue describe --task-queue buttery       # which workers are polling
```

The CLI defaults to `--address 127.0.0.1:7233`; set `TEMPORAL_NAMESPACE=buttery`
in your shell (or pass `--namespace buttery`) so it looks in the right place.

Note the `worker` process does not hot-reload: `node --watch` kills the SDK's
workflow sandbox on boot with `RangeError: Invalid atomic access index` (Node
26.7, reproducible, gone without the flag). Restart it instead —
`process-compose process restart worker`.

`services/worker/.env` (from `.env.example`, created by `pnpm dev`) answers both
"how do I reach Temporal" and "which atmosphere does a sweep read".
`ATPROTO_SYNC_SCHEDULE` is blank there on purpose.

## Deployment

`.railway/railway.ts` is the source of truth. Temporal is self-hosted, modelled
on Railway's [no-Elasticsearch
template](https://railway.com/deploy/temporal-or-durable-workflows-no-elastic):

| Service             | Image                          | Why                                                   |
| ------------------- | ------------------------------ | ----------------------------------------------------- |
| `temporal-postgres` | Railway Postgres               | Main + visibility schemas                             |
| `temporal`          | `temporalio/auto-setup:1.29.7` | The server; creates schemas and the namespace on boot |
| `temporal-ui`       | `temporalio/ui:2.53.1`         | The dashboard                                         |
| `temporal-auth`     | `railway-caddy-basic-auth`     | The UI has no login of its own                        |
| `worker`            | this repo                      | Our code                                              |

That is the price: four services and a second database before a single workflow
of ours runs, roughly a gigabyte of memory between them. Worth weighing against
what they replace — a step cursor, a lock, a scheduler, a dashboard and a backlog
control loop, none of which we now write.

Notes for whoever applies it:

- Nothing here has been applied. The graph evaluates and passes `validateGraph`;
  `railway config plan` needs auth this session did not have.
- Retiring the old `atproto-cron-sync` service is a **destructive** plan item —
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
