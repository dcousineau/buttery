# Local dev stack

`pnpm dev` boots the entire app as a single [process-compose](https://f1bonacc1.github.io/process-compose/) project defined in [`process-compose.yaml`](../process-compose.yaml). The commands live in the [README](../README.md); this document covers what the processes are and why the setup looks the way it does.

## Why a supervisor

Local dev needs several long-lived things running at once — Docker containers, an isolated atproto network, a Vite dev server — and both a human and an agent may want to look at them at the same time. `concurrently` (what this replaced) merged everything into one stdout stream with one lifecycle: no per-process restart, no per-process logs, no readiness ordering.

process-compose gives all three, plus a REST API. That last part is the important one: the stack is a **singleton**, and its state is queryable from outside. A human runs `pnpm dev` and watches the TUI; an agent in a different session inspects and restarts individual processes against that same instance without stealing the terminal or racing to start a second copy of the app. Running `pnpm dev` twice attaches to the existing project instead of failing on the bound port ([`scripts/dev/up.sh`](../scripts/dev/up.sh)).

The API port is pinned to `8099` via `PC_PORT_NUM` in `mise.toml` — repo-scoped, so no one has to pass `-p`, and it doesn't collide with the very common 8080 default.

## The MCP server (how agents should drive it)

The `mcp_server:` block in `process-compose.yaml` turns the same singleton into an MCP server on `localhost:8098`, registered as `process-compose` in `.mcp.json`. **Agents should prefer its `pc_*` tools to the CLI**: same REST API underneath, but the results come back as structured JSON instead of a formatted table an agent has to re-parse (and mis-parse) out of a shell.

`expose_control_tools: true` is what enables the built-in tools — `pc_project_state`, `pc_project_is_ready`, `pc_project_dependency_graph`, `pc_process_list`, `pc_process_get`, `pc_process_logs`, `pc_process_logs_search`, `pc_process_logs_truncate`, `pc_process_ports`, `pc_process_start`, `pc_process_stop`, `pc_process_restart`, `pc_process_scale`. Without it the server only serves per-process `mcp:` blocks, and this project defines none.

Three constraints worth knowing:

- **The server is part of the project**, so the tools exist only while the stack is up. Booting and tearing down the stack itself are therefore CLI-only, and an agent that finds the tools unreachable should read that as "the stack is down" and start it.
- **Transport is `sse`, not `stdio`.** The stdio alternative has the MCP client spawn its own `process-compose`, which is exactly the second copy the singleton design exists to prevent.
- **Port 8098** sits next to the REST API's 8099 and clear of the web server's 3000 — process-compose's own default for this is 3000, which would collide.

Editing the `mcp_server:` block needs a full project restart (`process-compose down` + `up`) _and_ an MCP client reconnect; a per-process restart reloads nothing.

## The processes

| Process           | What it is                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `postgres`        | The Postgres container — attached `docker compose up`, probed with `pg_isready`             |
| `redis`           | The Redis container — attached `docker compose up`, probed with `redis-cli ping`            |
| `migrate`         | `db:migrate:up`, gated on Postgres reporting ready                                          |
| `atproto-dev-env` | Isolated PDS + local PLC on `localhost:2583` / `:2582`, probed on `/xrpc/_health`           |
| `web`             | TanStack Start dev server on port 3000, gated on migrations, Redis, and the atproto dev-env |
| `pipeline`        | BullMQ producer + Bull Board UI on port 3002, probed on `/health`                           |
| `pipeline-worker` | BullMQ worker — drains every queue the pipeline declares                                    |
| `atproto-sync`    | One atproto → Postgres sync sweep — **manual one-shot**, boots `Disabled`                   |
| `docs`            | Docusaurus site on port 3001 — **opt-in**, boots `Disabled` (see below)                     |

### The opt-in `docs` process

`docs` is a second bundler that nothing else in the stack depends on, so it carries `disabled: ${BUTTERY_DOCS_DISABLED:-true}`: process-compose loads it — dependencies, readiness probe, `.dev-logs/docs.log` and all — but leaves it in `Disabled` state instead of starting it. Start it whichever way suits:

```bash
# ...from the TUI: select `docs`, then the "Start Process" shortcut in the footer
process-compose process start docs        # against an already-running stack
BUTTERY_DOCS_DISABLED=false pnpm dev      # whole stack, docs included, from cold
pnpm dev docs                             # docs + its dependencies only
```

The last two are worth distinguishing. The env var flips the `disabled` default, so the stack boots exactly as usual plus `docs`. Naming a process on `up` instead overrides `disabled` for that process _and_ narrows the boot to it and its dependency closure — handy for a docs-only session, but no `web`.

`vars:` + `{{ .X }}` templating does **not** work for this: templated values stay strings and `disabled` is a bool, so the config fails to parse. Plain `${VAR:-default}` expansion does.

### The `pipeline` pair

`pipeline` and `pipeline-worker` are one package (`@buttery/pipeline`) run as two processes, which is exactly how they deploy: the producer + Bull Board UI on one side, the worker fleet on the other. Splitting them locally is not ceremony — it is the only arrangement in which a "board is up but nothing drains the queue" bug shows up on a laptop instead of in production.

Both boot with the stack rather than opting in like `docs`. The queues are empty until something enqueues, so an idle pair costs two Node processes and no Redis traffic beyond BullMQ's blocking read, and having them up means the board at <http://127.0.0.1:3002/ui> is always there to look at.

`pipeline` depends only on `redis` — the queue itself. `pipeline-worker` also waits on `migrate`, because the jobs it runs write tables the migrations create.

To watch several workers compete for one queue the way Railway replicas do, scale the process:

```bash
process-compose process scale pipeline-worker 3   # or the pc_process_scale MCP tool
```

Configuration is `services/pipeline/.env`. The board's basic auth is off locally (blank `PIPELINE_AUTH_PASSWORD`) and mandatory in production — see [the service README](../services/pipeline/README.md), which also covers how the Railway autoscaler decides.

Schedules are off locally too. `ATPROTO_SYNC_SCHEDULE` is blank in the example `.env` so a laptop does not quietly sweep the live atmosphere in the background; on Railway it is `0 * * * *`, which is what replaced the cron service. Set it here and restart `pipeline` to get the same thing locally, or trigger one sweep on demand without any schedule at all:

```bash
curl -X POST http://127.0.0.1:3002/jobs/atproto-sync -d '{}' -H 'content-type: application/json'
```

### The manual `atproto-sync` one-shot

The sweep is a periodic batch job, not part of the interactive app, so it is defined but never boots: `disabled: true` plus `restart: "no"` make it a **manual one-shot** — `migrate`'s lifecycle with `docs`'s opt-in. Start it from the TUI, or:

```bash
process-compose process start atproto-sync   # against a running stack
pnpm dev atproto-sync                        # from cold: it, migrate, and the dev-env
```

Each run is one idempotent sweep that ends `Completed`; start it again after every publish to pull the new record into the `recipe` tables.

The process declares no environment of its own. **Which network gets swept is `services/pipeline/.env`'s call** — the same file a shell run reads, so both do the same thing:

```bash
pnpm --filter=@buttery/pipeline sync:trigger [--dry-run]
```

Its defaults are the **local dev-env** (`ATPROTO_PLC_URL=http://localhost:2582`, `SYNC_PDS_URL=http://localhost:2583`), matching `services/web/.env`, which points publishing at that same PDS. The two halves have to agree, or dev is incoherent in both directions: a sweep against the real atmosphere never sees the record the app just published, and it pulls thousands of strangers' repos to miss it.

`SYNC_PDS_URL` swaps the relay's `listReposByCollection` for that one PDS's `listRepos`, because dev-env ships no relay and its PDS refuses the former unauthenticated (`AuthMissing`). Setting it also makes the sweep **partial** — no missing-repo reconciliation, since one PDS is no basis for calling anything absent.

To sweep the real atmosphere from here instead, comment those two lines and uncomment the `plc.directory` pair sitting under them; `RELAY_URL` is already set and is simply ignored while `SYNC_PDS_URL` is. Production never reads this file — [`.railway/railway.ts`](../.railway/railway.ts) sets `RELAY_URL` and leaves the other two unset, so the deployed sweep resolves through `plc.directory` and enumerates through the relay.

There is a third way to run the same sweep — `POST /jobs/atproto-sync` on the pipeline — and it obeys that same `.env`. It is the one that shows the sweep's five steps, their progress and their failures in the Bull Board UI, and it is what the hourly production schedule uses. Prefer this process for a quick one-off; prefer the queue when you want to watch it.

All three go through the same `Workflow.run`, so they run the same graph — `enumerate` fans out one job per repo, and `finalize` folds them once every one has settled — and take the same fleet-wide Redis lock: start a sweep while one is already going and the second **skips** rather than running alongside it.

Through the queue, a sweep is dozens of jobs rather than one, which is what the board is worth looking at for: `process-compose process scale pipeline-worker 3` and they spread across the replicas, up to the `ATPROTO_SYNC_MAX_IN_FLIGHT` cap.

## How the dev containers are wired in

Postgres and Redis are defined in a committed [`docker-compose.yml`](../docker-compose.yml) at the repo root — no Railway CLI, no auth, no per-clone generated file. `railway dev` used to write that compose file into machine-local state (`~/.railway/develop/<project-id>/…`) with live production credentials baked in; now the repo owns it outright, with fixed host ports and throwaway local-only credentials (see the compose file's header).

There is no separate "start the containers" step. The `postgres` and `redis` processes each run `docker compose up <service>` **in the foreground**, so the process _is_ the container: process-compose starts it, streams its logs, restarts it, and stops it. Both invocations race to create the shared compose network on a cold boot; whichever loses logs a one-line `network buttery_default already exists` error and carries on.

That single-supervisor arrangement is why `docker-compose.yml` declares no `restart:` policy. With one, docker would try to resurrect a container that compose is simultaneously tearing down after the attached `up` returned.

The ports are fixed and repo-owned: **Postgres on host `55432`, Redis on `56379`** (mapped to the containers' standard 5432/6379). They sit in the high range so a Postgres/Redis you already run on the defaults doesn't collide. `services/web/.env` points `DATABASE_URL`/`REDIS_URL` at them; because we own the ports now, hardcoding them in `.env` is correct rather than fragile (under `railway dev` they were reassigned on every `up`, so nothing downstream could pin them). Each service keeps its own `.env` next to its `.env.example` — `services/web/.env` and `services/pipeline/.env` today — and [`scripts/dev/bootstrap-env.mjs`](../scripts/dev/bootstrap-env.mjs) creates any that are missing on `pnpm dev` / `mise install`, never touching one that exists.

Two consequences worth remembering:

- **The containers stop with the stack.** `pnpm dev:down` (just `process-compose down` now) takes them down too. The named volumes are untouched, so no data is lost — starting the stack again reuses them.
- **`docker compose down -v` wipes the Postgres volume.** The next `pnpm dev` re-runs migrations automatically, which is why `migrate` is a boot step rather than a documented manual command.

## Container lifecycle details

**Readiness** is a real protocol check from inside the container — `pg_isready` and an authenticated `redis-cli ping` — so `process_healthy` means "answering queries", not "container started". Both run through `docker compose exec -T` rather than `docker exec <name>`: it avoids hardcoding the `buttery-postgres-1` naming convention, and `-T` is required because process-compose runs probes with a non-tty stdin, which plain `exec` refuses. Costs ~40ms per probe against a 2s period. The redis probe must match `PONG` rather than trust the exit code — an unauthenticated `redis-cli ping` answers `NOAUTH Authentication required.` and still exits 0.

**Restarts** are `restart: always`, and it has to be `always`: when a container dies, the attached `up` can return 0, which `on_failure` would file as a clean completion and leave the process dead — taking the readiness probe `web` gates on with it. With `always`, `docker kill buttery-redis-1` is back to `Ready` in a few seconds.

**Shutdown** of `redis` is the ordinary SIGTERM: it's `exec`d as PID 1, handles the signal itself, and exits 0 in about a second. `postgres` can't be stopped by a signal at all — its PID 1 is the image's `wrapper.sh`, which neither traps signals nor `exec`s postgres, so SIGTERM is swallowed and `docker compose stop` burns the full 10s grace period before SIGKILL (exit 137, and crash recovery on the next boot). The `postgres` process therefore carries an explicit `shutdown.command` that runs `pg_ctl stop -m fast` inside the container: clients are disconnected, open transactions roll back, the container exits 0 in well under a second, and the attached `up` ends on its own. Whole-stack teardown is ~0.5s. This is worth knowing if you stop the container by hand — `docker compose stop postgres` still takes the slow, unclean path.

The app processes (`atproto-dev-env`, `web`) use `restart: on_failure` with `max_restarts: 5`, so a transient crash heals itself while a genuinely broken config still gives up instead of looping.

Restarting `atproto-dev-env` keeps the **same** `did:plc`: the PDS sqlite, blobstore, and a snapshot of the local PLC log all persist under `.dev-data/atproto/` (gitignored), so browser sessions survive a restart. Deleting that directory mints a new DID and orphans any buttery rows keyed to the old one.

## Logs

Every process writes a plain-text log to `.dev-logs/<process>.log` (gitignored), line-flushed so a tail is never stale. Format is `<time> <INF|ERR> <line>` — note that `ERR` only means the line came from stderr, which plenty of well-behaved tools use for ordinary chatter.

`pnpm dev` wipes `.dev-logs/*.log` on every fresh boot (the start path only — attaching to a live stack leaves them alone), so a tail always shows the current run and nothing older.

All three sources are equivalent; use whichever fits:

| Source                                             | Good for                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pc_process_logs` / `pc_process_logs_search` (MCP) | Agents — structured results, and BM25 search across every process's buffer at once |
| `process-compose process logs web --tail 50`       | Humans at a shell, and agents when the stack's MCP server isn't reachable          |
| `grep -i error .dev-logs/web.log`                  | Plain file — greppable, and the only source that survives shutdown                 |

Note that the in-memory buffer and the file are separate stores: `pc_process_logs_truncate` (or `process-compose process logs truncate`) empties the buffer only, and the file keeps growing.
