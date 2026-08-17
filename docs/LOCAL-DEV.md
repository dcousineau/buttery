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
| `dev-containers`  | One-shot `docker compose up -d --wait` — starts Postgres + Redis, waits for healthy, exits  |
| `postgres`        | Log stream + `pg_isready` probe for the Postgres container                                  |
| `redis`           | Log stream + `redis-cli ping` probe for the Redis container                                 |
| `migrate`         | `db:migrate:up`, gated on Postgres reporting ready                                          |
| `atproto-dev-env` | Isolated PDS + local PLC on `localhost:2583` / `:2582`, probed on `/xrpc/_health`           |
| `web`             | TanStack Start dev server on port 3000, gated on migrations, Redis, and the atproto dev-env |
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

The cron sync service is deliberately absent — it's a periodic batch job, not part of the interactive app. Run it on demand:

```bash
railway run --service atproto-cron-sync -- pnpm --filter=@buttery/atproto-cron-sync sync:once
```

## How the dev containers are wired in

Postgres and Redis are defined in a committed [`docker-compose.yml`](../docker-compose.yml) at the repo root — no Railway CLI, no auth, no per-clone generated file. `railway dev` used to write that compose file into machine-local state (`~/.railway/develop/<project-id>/…`) with live production credentials baked in; now the repo owns it outright, with fixed host ports and throwaway local-only credentials (see the compose file's header).

`docker compose up -d --wait` isn't a supervisable process: it starts a detached container stack, blocks until both healthchecks pass, and exits 0. It's also idempotent, so re-running it against a live stack is a fast no-op. That makes it a natural one-shot gate — every other process depends on the `dev-containers` step _completing successfully_ rather than staying up, and `--wait` means "completed" already implies "healthy".

The containers themselves are then surfaced as two separate process-compose services, each tailing one container via [`scripts/dev/dev-containers.mjs`](../scripts/dev/dev-containers.mjs). That script also implements the readiness probes. Everything it does goes through `docker compose -f docker-compose.yml` rather than `docker logs`/`docker exec` against a container name, and that detail is load-bearing — see "Why the tails go through `docker compose`" below.

The ports are fixed and repo-owned: **Postgres on host `55432`, Redis on `56379`** (mapped to the containers' standard 5432/6379). They sit in the high range so a Postgres/Redis you already run on the defaults doesn't collide. `services/web/.env` points `DATABASE_URL`/`REDIS_URL` at them; because we own the ports now, hardcoding them in `.env` is correct rather than fragile (under `railway dev` they were reassigned on every `up`, so nothing downstream could pin them).

Two consequences worth remembering:

- **Stopping process-compose does not stop the databases.** The containers are detached and outlive it; only the log tails die. `pnpm dev:down` does both (`process-compose down` then `docker compose down`).
- **`docker compose down -v` wipes the Postgres volume.** The next `pnpm dev` re-runs migrations automatically, which is why `migrate` is a boot step rather than a documented manual command.

## Why the tails go through `docker compose`

`docker logs -f` **dies the moment its container restarts, and exits 0**. The containers ship with `restart: unless-stopped`, so this happens on any crash. Exit 0 means process-compose files the tail as `Completed` rather than failed and leaves it dead — and since `postgres` and `redis` carry the readiness probes `web` gates on (`condition: process_healthy`), a dead tail means the web server can never come back. The container is fine the whole time; only its supervisor thinks otherwise.

`docker compose logs -f <service>` follows the _service_ and reattaches across both container restarts and full recreates, so the tail (and therefore the probe) survives. The probes use `docker compose exec -T` for the same reason: it drops the `<project>-<service>-1` container-naming assumption. The extra overhead is ~40ms per probe, against a 2s period.

Belt and braces on top of that, the three tails carry `availability: restart: always`. It has to be `always` — `on_failure` would ignore an exit 0.

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
