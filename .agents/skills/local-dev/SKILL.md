---
name: local-dev
description: Use for buttery local dev stack — check if up, read per-process logs (especially web server), restart/stop single process, clear logs, tear down, run extra web dev server on second port. Use before starting any dev server, before debugging runtime error, and whenever need see what app printed.
user-invocable: true
---

# Local dev stack

Whole local app = **one singleton [process-compose](https://f1bonacc1.github.io/process-compose/) project** (`process-compose.yaml`): `railway dev` containers, migrations, atproto dev-env, web server. Config at repo root; background in `docs/LOCAL-DEV.md`.

Human maybe attached to TUI now. **No start competing dev server** — drive running instance.

Processes: `railway-dev`, `postgres`, `redis`, `railway-proxy`, `migrate`, `atproto-dev-env`, `web`.

## Use the MCP tools, not the CLI

Running stack expose **MCP server** (`process-compose` in `.mcp.json`, SSE on `localhost:8098`). **Prefer `pc_*` tools for everything they cover** — structured JSON back, no shell quoting, no ANSI codes to strip.

| Want                    | Tool                          | Args                            |
| ----------------------- | ----------------------------- | ------------------------------- |
| is it up / how long     | `pc_project_state`            | `with_memory?`                  |
| all processes + health  | `pc_process_list`             | —                               |
| one process (incl. pid) | `pc_process_get`              | `name`                          |
| everything ready yet    | `pc_project_is_ready`         | —                               |
| recent log lines        | `pc_process_logs`             | `name`, `tail?`, `offset_from_end?` |
| find a line in logs     | `pc_process_logs_search`      | `query`, `name?`, `top_k?`, `log_limit?` |
| clear log buffer        | `pc_process_logs_truncate`    | `name`                          |
| restart one process     | `pc_process_restart`          | `name`                          |
| stop / start one        | `pc_process_stop` / `pc_process_start` | `names` (array) / `name` |
| what port it listen on  | `pc_process_ports`            | `name`                          |
| why is it stuck Pending | `pc_project_dependency_graph` | —                               |

**MCP server live inside project** — tools exist only while stack up. Two things CLI-only:

- **boot stack** — `process-compose up --detached` (or `pnpm dev` for human TUI)
- **tear down stack** — `process-compose down`, `pnpm dev:down`

CLI equivalents (`process-compose process list`, `… logs web`, …) still work against REST API on port `8099` (`PC_PORT_NUM` in `mise.toml`). Use when tools unavailable (stack down, MCP not connected) or need something tools lack. Plain-text files under `.dev-logs/` always work, survive shutdown.

## Is it up?

Ask `pc_project_state`. Tool error / server unreachable = stack down (MCP endpoint die with project). Confirm with CLI if unsure:

```bash
process-compose project state          # non-zero exit = not running
```

Not running → start it, no ask user:

```bash
process-compose up --detached          # background; use this from an agent
pnpm dev                               # foreground TUI; blocks — humans only
```

Then poll `pc_project_is_ready` until `{"ready":true,"total":7}`. Return immediately — unlike CLI `project is-ready --wait`, which hang forever and eat whole tool timeout. **Never use `--wait`.**

Stack just booted, MCP not connected yet? Poll port instead:

```bash
for i in $(seq 1 60); do
  c=$(curl -s -m 3 -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/)
  [ "$c" = "200" ] && break
  command sleep 1
done; echo "http=$c"
```

`command sleep` because foreground `sleep` blocked in agent shell.

## Web server: logs

Three sources. `pc_process_logs` for tail, `pc_process_logs_search` for finding, file for grep.

```
pc_process_logs        { name: "web", tail: 100 }
pc_process_logs_search { name: "web", query: "ECONNREFUSED cause" }
```

```bash
grep -i error .dev-logs/web.log
tail -50 .dev-logs/web.log
```

`pc_process_logs_search` rank by **BM25 relevance, not time** — hits maybe old or out of order. Sort by `chunk_idx` descending for recency, or use `pc_process_logs` when want latest output.

Every process have file: `.dev-logs/<process>.log` (`web`, `postgres`, `redis`, `railway-proxy`, `migrate`, `atproto-dev-env`, `railway-dev`). Line-flushed, so tail never stale.

Line format `<time> <INF|ERR> <line>`. **`ERR` only mean line came from stderr** — pnpm, vite, postgres all write ordinary status there. No report `ERR` lines as failures without reading them.

## Web server: control and reboot

```
pc_process_restart { name: "web" }     # normal way to pick up change HMR missed
pc_process_stop    { names: ["web"] }
pc_process_start   { name: "web" }
pc_process_get     { name: "web" }     # status + pid of one process
```

Restart `web` alone. Never restart whole stack to fix web server.

**Prove restart took** — `pc_process_get` report `pid` directly:

1. `pc_process_get {name:"web"}` → note `pid`
2. `pc_process_restart {name:"web"}`
3. poll `pc_project_is_ready`
4. `pc_process_get {name:"web"}` → pid changed = fresh process

One restart enough. Repeat restarts to "be sure" only churn pid and lose log context.

**Restart does NOT reload `process-compose.yaml`.** Commands captured when project starts, so editing a process's `command:` and restarting that process silently re-runs OLD command — and `pid changed` still say success, so it look fine. Confirm what actually runs:

```bash
ps -eo command | grep -a "dev:web" | grep -av grep
```

Config change → full project restart, which does reload (CLI-only):

```bash
process-compose down            # containers keep running
process-compose up --detached
```

Editing `mcp_server:` block need same full restart, **plus** MCP client reconnect (Claude Code: `/mcp`, or restart session).

Two restarts have side effects:

- **`atproto-dev-env`** persist state in `.dev-data/atproto/` — restart keep same `did:plc`, browser session survive. Deleting that dir mint new DID and orphan buttery rows pointing at old one.
- **`migrate`** one-shot; restart after adding migration instead of running `db:migrate:up` by hand.

## A second web server on another port

Only when truly need two app instances at once (e.g. compare branches). Stack keep port 3000; give second one own port **and** matching URL vars, else atproto OAuth build redirects for wrong origin:

```bash
railway run --service buttery -- env PORT=3100 BETTER_AUTH_URL=http://127.0.0.1:3100 VITE_APP_URL=http://127.0.0.1:3100 \
  pnpm --filter @buttery/web exec vite dev --port 3100
```

Notes:

- `railway run` inject `DATABASE_URL` / `REDIS_URL`; without it server have no database.
- `env VAR=…` must prefix **child** command — Railway injected vars beat shell exports.
- Bypass `pnpm dev:web`, which hardcode `--port 3000`. Also skip lexicon build; run `pnpm --filter @buttery/lexicons build` first if `src/generated` stale.
- Both servers share one database. Not isolated.
- Not supervised — process-compose don't know about it, so `pc_*` tools can't see or stop it. Kill by hand when done (Ctrl-C, or `pkill -f "vite dev --port 3100"`).

## Signing in with a local fake account

`atproto-dev-env` PDS = full OAuth authorization server (`/oauth/par`, `/oauth/authorize`, `/oauth/token`), so app's real sign-in flow work against it. Seed account: handle **`chef.test`**, password **`devpw-chef-000`** (override via `ATPROTO_DEV_HANDLE` / `ATPROTO_DEV_PASSWORD`). Sign in at http://127.0.0.1:3000/login.

Need `services/web/.env` to carry:

```
ATPROTO_HANDLE_RESOLVER=http://localhost:2583
ATPROTO_PLC_URL=http://localhost:2582
ATPROTO_PUBLISH_ENABLED=true
```

Check handshake without browser — `{"url":"http://localhost:2583/oauth/authorize?…"}` response mean it work:

```bash
curl -s -X POST http://127.0.0.1:3000/api/auth/atproto/sign-in \
  -H 'Content-Type: application/json' -d '{"handle":"chef.test"}'
```

`Failed to resolve OAuth server metadata for resource: http://localhost:2583/` mean app did not decide it is loopback, so `allowHttp` off. Cause almost always non-loopback `BETTER_AUTH_URL` — `railway run` inject production `https://buttery.recipes` and Railway values beat `.env`, which why `process-compose.yaml` re-override it on `web` child command. Real cause show up under `[cause]` — `pc_process_logs_search {name:"web", query:"cause"}` — not in HTTP response.

Seed account DID **stable** across restarts (state in `.dev-data/atproto/`), so one sign-in survive dev-env reboots. Resolve current DID at runtime, never hardcode:

```bash
pnpm -s --filter @buttery/atproto-dev-env records   # prints `DID did:plc:…`
```

Deleting `.dev-data/atproto/` mint new DID — buttery rows keyed to old one stop resolving.

## Clearing logs

`pnpm dev` wipe `.dev-logs/*.log` on fresh boot only. Restarting process does NOT clear anything — clear by hand. Two separate stores:

```
pc_process_logs_truncate { name: "web" }   # in-memory buffer only — file survives
```

```bash
: > .dev-logs/web.log                       # the file; safe while process running
```

Truncating only buffer leave file full, and vice versa. Clear both when want clean read.

**Order matter.** Clear, THEN trigger, THEN read:

1. `pc_process_restart {name:"web"}`
2. poll `pc_project_is_ready`
3. `pc_process_logs_truncate {name:"web"}` and `: > .dev-logs/web.log` — clear AFTER boot noise
4. …now load the page…
5. `pc_process_logs {name:"web", tail:50}`

Clear after request = throw away evidence. Clear before restart = boot chatter mixed in. Empty log prove nothing — when need proof, capture boot + request together.

## Cleanup

```bash
pnpm dev:down          # stop the stack AND the railway dev containers
process-compose down   # stop the stack only — containers keep running
railway dev clean      # ALSO wipes the postgres volume; next `pnpm dev` re-migrates
```

`process-compose down` alone leave Postgres/Redis/Caddy up: detached docker containers, process-compose only tail their logs. Taking project down also kill MCP server on 8098.

## Gotchas

- `curl` return `000` have TWO causes: stack down, or command sandbox blocking `localhost:3000`. Check `pc_project_state` BEFORE blaming sandbox — else you assert "sandbox" at dead server, walk it back later. Stack up + `000` = sandbox: verify pages with Chrome MCP tools, run DB-touching commands with sandbox disabled.
- macOS `grep` treat curl'd SSR HTML as **binary** (one huge line, UTF-8 punctuation) and exit 1 silently — look exactly like real miss. Always `grep -a` on fetched HTML, else every content assertion lie.
- Vite auto-bump 3000 → 3001 if port busy. `pc_process_ports {name:"web"}` show real port; usual cause = second dev server someone forgot to kill.
- Browse **http://127.0.0.1:3000**, never `localhost` — atproto loopback client and session cookie bound to `127.0.0.1`.
- `postgres`/`redis`/`railway-proxy` = **log tails over `docker compose`**, not containers. Tails survive container restart and recreate, carry `restart: always`; `web`/`atproto-dev-env` carry `restart: on_failure` with `max_restarts: 5`. So process stuck dead = real failure, not old flaky-tail bug — read its log before restarting. Restarting tail never restart container (`docker restart <name>` for that).