---
name: local-dev
description: Use for buttery local dev stack — check if up, read per-process logs (especially web server), restart/stop single process, clear logs, tear down, run extra web dev server on second port. Use before starting any dev server, before debugging runtime error, and whenever need see what app printed.
user-invocable: true
---

# Local dev stack

Whole local app = **one singleton [process-compose](https://f1bonacc1.github.io/process-compose/) project**: docker-compose containers (postgres, redis, minio), migrations, bucket create, atproto dev-env, web server.

Files — no search for them:

| Path                                  | What                                                     |
| ------------------------------------- | -------------------------------------------------------- |
| `process-compose.yaml` (repo root)    | the whole stack definition — every process, port, env    |
| `.dev-logs/<process>.log` (repo root) | per-process log files, survive shutdown                  |
| `mise.toml` (repo root)               | pinned tool versions, `PC_PORT_NUM`                      |

`docs/LOCAL-DEV.md` = human background, very large. **Do not read it.** This skill carry everything agent need; read that file only when skill lack answer AND `process-compose.yaml` lack it too.

Human maybe attached to TUI now. **No start competing dev server** — drive running instance.

## MCP first, CLI last

Running stack expose **MCP server** (`process-compose` in `.mcp.json`, SSE on `localhost:8098`). **`pc_*` tools are the interface.** List them, read schemas, discover process names from `pc_process_list`. Structured JSON back, no shell quoting, no ANSI strip.

MCP server live inside project — tools die with stack. Two things CLI-only:

- **boot** — `process-compose up --detached` (agents), `pnpm dev` (human TUI, blocks)
- **tear down** — `process-compose down`, `pnpm dev:down`

Else: CLI only when tools unavailable (stack down, MCP not connected) or lack capability. CLI hit same REST API on port `8099` (`PC_PORT_NUM` in `mise.toml`). `.dev-logs/<process>.log` plain files always readable, survive shutdown.

## Is it up?

`pc_project_state`. Tool error / unreachable = stack down. Not running → start it, no ask user.

After boot poll `pc_project_is_ready` until `{"ready":true,"total":6}` — return immediately, unlike CLI `project is-ready --wait` which hang forever and eat whole tool timeout. **Never `--wait`.**

MCP not reconnected yet after fresh boot? Poll `http://127.0.0.1:3000/` with `curl` in loop. Foreground `sleep` blocked in agent shell — use `command sleep 1`.

## Logs

`pc_process_logs` for tail, `pc_process_logs_search` for finding, `.dev-logs/<name>.log` for grep.

- `pc_process_logs_search` rank by **BM25 relevance, not time** — hits maybe old or out of order. Sort by `chunk_idx` descending for recency, or use `pc_process_logs` for latest.
- Line format `<time> <INF|ERR> <line>`. **`ERR` only mean line came from stderr** — pnpm, vite, postgres all write ordinary status there. No report `ERR` lines as failures without reading them.
- Files line-flushed, never stale.

## Restart

Restart one process, never whole stack. **Prove it took**: `pc_process_get` before → note `pid` → restart → poll `pc_project_is_ready` → `pc_process_get` again, pid changed = fresh. One restart enough; repeats churn pid and lose log context.

**Restart does NOT reload `process-compose.yaml`.** Commands captured at project start, so editing a `command:` and restarting that process silently re-runs OLD command — and pid still change, so it look fine. Confirm what actually runs:

```bash
ps -eo command | grep -a "dev:web" | grep -av grep
```

Config change → full project restart (CLI-only, `process-compose down` then `up --detached`). Editing `mcp_server:` block need that **plus** MCP client reconnect (Claude Code: `/mcp`).

Two restarts have side effects:

- **`atproto-dev-env`** persist state in `.dev-data/atproto/` — restart keep same `did:plc`, browser session survive. Deleting that dir mint new DID and orphan buttery rows pointing at old one.
- **`migrate`** one-shot; restart it after adding migration instead of running `db:migrate:up` by hand.

## Clearing logs

`pnpm dev` wipe `.dev-logs/*.log` on fresh boot only. Restart clear nothing. Two separate stores — `pc_process_logs_truncate` empty in-memory buffer, `: > .dev-logs/web.log` empty file. Clear both or reads stay dirty.

**Order matter**: restart → wait ready → clear both (AFTER boot noise) → trigger → read. Clear after request throw away evidence. Empty log prove nothing; when need proof capture boot + request together.

## A second web server on another port

Only when truly need two app instances at once (e.g. compare branches). Stack keep 3000; second one need own port **and** matching URL vars, else atproto OAuth build redirects for wrong origin:

```bash
env PORT=3100 BETTER_AUTH_URL=http://127.0.0.1:3100 VITE_APP_URL=http://127.0.0.1:3100 \
  pnpm --filter @buttery/web exec vite dev --port 3100
```

- `env VAR=…` prefix overrides the same keys in `services/web/.env` — `process.loadEnvFile()` (vite.config.ts) never clobbers a var already in the environment.
- Bypass `pnpm dev:web`, which hardcode `--port 3000`. Also skip lexicon build; run `pnpm --filter @buttery/lexicons build` first if `src/generated` stale.
- Both servers share one database. Not isolated.
- Not supervised — `pc_*` tools can't see or stop it. Kill by hand (`pkill -f "vite dev --port 3100"`).

## Signing in with a local fake account

`atproto-dev-env` PDS = full OAuth authorization server, so app's real sign-in flow work against it. Seed account: handle **`chef.test`**, password **`devpw-chef-000`** (override via `ATPROTO_DEV_HANDLE` / `ATPROTO_DEV_PASSWORD`). Sign in at http://127.0.0.1:3000/login.

`services/web/.env` must carry:

```
ATPROTO_HANDLE_RESOLVER=http://localhost:2583
ATPROTO_PLC_URL=http://localhost:2582
ATPROTO_PUBLISH_ENABLED=true
```

Check handshake without browser — POST `{"handle":"chef.test"}` to `/api/auth/atproto/sign-in`; a `{"url":"http://localhost:2583/oauth/authorize?…"}` response mean it work.

`Failed to resolve OAuth server metadata for resource: http://localhost:2583/` mean app did not decide it is loopback, so `allowHttp` off. Cause almost always non-loopback `BETTER_AUTH_URL` — must stay `http://127.0.0.1:3000` in `services/web/.env`, which is authoritative now that no `railway run` wrapper inject production `https://buttery.recipes`. Real cause show up under `[cause]` in web logs, not in HTTP response.

Seed DID **stable** across restarts. Resolve at runtime, never hardcode:

```bash
pnpm -s --filter @buttery/atproto-dev-env records   # prints `DID did:plc:…`
```

## Loading seed data

Empty database boring. Recipe corpus for grocery list, meal plan, calibration sweep live in kysely-ctl seed, `services/web/src/db/seeds/`. One command:

```bash
pnpm --filter @buttery/web db:seed:run
```

- **Manual only. NEVER automatic.** No process, no hook, no CI run it. `migrate` process = migrations only, keep it that way. Human type command or no corpus.
- Safe re-run. Every row keyed `seed-<slug>`, upserted — your own imported recipes untouched, meal-plan and grocery-list rows pointing at seeded recipe survive. Run twice, same counts.
- kysely-ctl **no track seeds** like migrations — no `kysely_seed` table. `db:seed:run` run every seed file every time. That why idempotent matter.
- Need household first. No household = seed print "sign in first" and stop. Sign in as `chef.test` (see above), then run.
- Sandbox block dev DB — run sandbox-disabled.
- `db:seed:list` show seed files. `db:seed:make <name>` mint new one — **never hand-name file**, same clock-drift reason as migrations (AGENTS.md).

## Cleanup

```bash
pnpm dev:down            # == `process-compose down`; stops containers too
docker compose down -v   # ALSO wipes the postgres volume; next `pnpm dev` re-migrates
```

Stack down = containers down: `postgres`/`redis` processes ARE the containers (attached `docker compose up`). Named volumes survive, so no data lost — only `down -v` wipe data. Taking project down also kill MCP server on 8098.

## Gotchas

- `curl` return `000` have TWO causes: stack down, or command sandbox blocking `localhost:3000`. Check `pc_project_state` BEFORE blaming sandbox — else you assert "sandbox" at dead server, walk it back later.
- macOS `grep` treat curl'd SSR HTML as **binary** (one huge line, UTF-8 punctuation) and exit 1 silently — look exactly like real miss. Always `grep -a` on fetched HTML, else every content assertion lie.
- Vite auto-bump 3000 → 3001 if port busy. `pc_process_ports` show real port; usual cause = second dev server someone forgot to kill.
- `postgres`/`redis`/`minio` **ARE the containers** — each process run `docker compose up <svc>` attached. So `pc_process_restart postgres` really restart the container, and its log = container log. They carry `restart: always` (attached `up` can exit 0 on container death, which `on_failure` would file as clean); `web`/`atproto-dev-env` carry `restart: on_failure` + `max_restarts: 5`. Process stuck dead = real failure — read its log before restarting.
- `docker compose stop postgres` by hand take 10s and SIGKILL (image PID 1 = `wrapper.sh`, swallow signals). Stack teardown avoid this with in-container `pg_ctl stop -m fast`. Prefer `pnpm dev:down` / `pc_process_stop postgres` over raw docker stop.