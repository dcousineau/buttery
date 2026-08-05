# Local dev stack

`pnpm dev` boots the entire app as a single [process-compose](https://f1bonacc1.github.io/process-compose/) project defined in [`process-compose.yaml`](../process-compose.yaml). The commands live in the [README](../README.md); this document covers what the processes are and why the setup looks the way it does.

## Why a supervisor

Local dev needs several long-lived things running at once — Docker containers, an isolated atproto network, a Vite dev server — and both a human and an agent may want to look at them at the same time. `concurrently` (what this replaced) merged everything into one stdout stream with one lifecycle: no per-process restart, no per-process logs, no readiness ordering.

process-compose gives all three, plus a REST API. That last part is the important one: the stack is a **singleton**, and its state is queryable from outside. A human runs `pnpm dev` and watches the TUI; an agent in a different session runs `process-compose process list` / `… logs web` / `… restart web` against that same instance without stealing the terminal or racing to start a second copy of the app. Running `pnpm dev` twice attaches to the existing project instead of failing on the bound port ([`scripts/dev/up.sh`](../scripts/dev/up.sh)).

The API port is pinned to `8099` via `PC_PORT_NUM` in `mise.toml` — repo-scoped, so no one has to pass `-p`, and it doesn't collide with the very common 8080 default.

## The processes

| Process           | What it is                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `railway-dev`     | One-shot `railway dev up --no-tui` — starts the containers, prints the port/credential overview, exits |
| `postgres`        | Log stream + `pg_isready` probe for the Postgres container                                             |
| `redis`           | Log stream + `redis-cli ping` probe for the Redis container                                            |
| `railway-proxy`   | Log stream for the Caddy proxy container                                                               |
| `migrate`         | `db:migrate:up`, gated on Postgres reporting ready                                                     |
| `atproto-dev-env` | Isolated PDS + local PLC on `localhost:2583` / `:2582`, probed on `/xrpc/_health`                      |
| `web`             | TanStack Start dev server on port 3000, gated on migrations, Redis, and the atproto dev-env            |

The cron sync service is deliberately absent — it's a periodic batch job, not part of the interactive app. Run it on demand:

```bash
railway run --service atproto-cron-sync -- pnpm --filter=@buttery/atproto-cron-sync sync:once
```

## How the Railway containers are wired in

`railway dev up` isn't a supervisable process: it starts a detached docker-compose stack and exits 0. It's also idempotent, so re-running it against a live stack just re-prints the overview. That makes it a natural one-shot gate — every other process depends on it _completing successfully_ rather than staying up.

The containers themselves are then surfaced as three separate process-compose services, each running `docker logs -f` against one container via [`scripts/dev/railway-containers.mjs`](../scripts/dev/railway-containers.mjs). That script also implements the readiness probes. It resolves the docker-compose project name (which is the Railway project id) at runtime from `~/.railway/config.json`, keyed by checkout path — that id is machine-local state and differs per clone, so it must never be hardcoded.

Two consequences worth remembering:

- **Stopping process-compose does not stop the databases.** The containers are detached and outlive it; only the log tails die. `pnpm dev:down` does both (`process-compose down` then `railway dev down`).
- **`railway dev clean` wipes the Postgres volume.** The next `pnpm dev` re-runs migrations automatically, which is why `migrate` is a boot step rather than a documented manual command.

Restarting `atproto-dev-env` mints a **new** `did:plc` (the dev-env is in-memory), so any session in the browser needs a fresh sign-in afterwards.

## Logs

Every process writes a plain-text log to `.dev-logs/<process>.log` (gitignored), line-flushed so a tail is never stale. Format is `<time> <INF|ERR> <line>` — note that `ERR` only means the line came from stderr, which plenty of well-behaved tools use for ordinary chatter.

`pnpm dev` wipes `.dev-logs/*.log` on every fresh boot (the start path only — attaching to a live stack leaves them alone), so a tail always shows the current run and nothing older.

Both sources are equivalent; use whichever fits:

```bash
process-compose process logs web --tail 50   # via the REST API, works from anywhere
grep -i error .dev-logs/web.log              # plain file, greppable, survives shutdown
```
