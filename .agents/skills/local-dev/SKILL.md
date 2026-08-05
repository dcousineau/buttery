---
name: local-dev
description: Use for buttery running local dev stack — check if up, read per-process logs (especially web server), restart/stop individual processes, clear logs, tear down, run extra web dev server on second port. Use before starting any dev server, before debugging runtime error in app, and whenever need see what app printed.
user-invocable: true
---

# Local dev stack

Whole local app run as **one singleton [process-compose](https://f1bonacc1.github.io/process-compose/) project** (`process-compose.yaml`): `railway dev` containers, migrations, atproto dev-env, web server. Config at repo root; background in `docs/LOCAL-DEV.md`.

Human may be attached to TUI right now. **Do not start competing dev server** — drive running instance with CLI below. All talk to its REST API (port `8099`, set by `PC_PORT_NUM` in `mise.toml`), safe from any directory in repo.

Processes: `railway-dev`, `postgres`, `redis`, `railway-proxy`, `migrate`, `atproto-dev-env`, `web`.

## Is it up?

```bash
process-compose project state          # non-zero exit = not running
process-compose process list -o wide   # per-process status + health
```

Not running → start it, don't ask user:

```bash
pnpm dev                               # foreground TUI; blocks
process-compose up --detached          # background; use this from an agent
```

Wait for ready before hitting app:

```bash
process-compose project is-ready --wait
```

## Web server: logs

Two equal sources. File for grep, API for tail.

```bash
process-compose process logs web -n 100        # last 100 lines
process-compose process logs web -f            # follow (blocks — use sparingly)

grep -i error .dev-logs/web.log
tail -50 .dev-logs/web.log
```

Every process have file: `.dev-logs/<process>.log` (`web`, `postgres`, `redis`, `railway-proxy`, `migrate`, `atproto-dev-env`, `railway-dev`). Line-flushed, so tail never stale.

Line format `<time> <INF|ERR> <line>`. **`ERR` only mean line came from stderr** — pnpm, vite, postgres all write ordinary status there. Don't report `ERR` lines as failures without reading them.

## Web server: control and reboot

```bash
process-compose process restart web    # the normal way to pick up a change that HMR missed
process-compose process stop web
process-compose process start web
process-compose process get web        # status of one process
```

Restart `web` alone. Never restart whole stack to fix web server.

**Prove a restart actually took**, without ad-hoc PID plumbing — `get` report the pid directly:

```bash
process-compose process get web -o wide      # note pid
process-compose process restart web
process-compose project is-ready --wait
process-compose process get web -o wide      # pid changed = fresh process
```

One restart enough. Repeat restarts to "be sure" only churn pid and lose log context.

Two restarts have side effects:

- **`atproto-dev-env`** in-memory PDS — restart mint new `did:plc`, so browser session must sign in again.
- **`migrate`** one-shot; restart after adding migration instead of running `db:migrate:up` by hand.

## A second web server on another port

Only when truly need two app instances at once (e.g. compare branches). Stack keep port 3000; give second one own port **and** matching URL vars, or atproto OAuth build redirects for wrong origin:

```bash
railway run --service buttery -- env PORT=3100 BETTER_AUTH_URL=http://127.0.0.1:3100 VITE_APP_URL=http://127.0.0.1:3100 \
  pnpm --filter @buttery/web exec vite dev --port 3100
```

Notes:

- `railway run` inject `DATABASE_URL` / `REDIS_URL`; without it server have no database.
- `env VAR=…` must prefix **child** command — Railway injected vars beat shell exports.
- Bypass `pnpm dev:web`, which hardcode `--port 3000`. Also skip lexicon build; run `pnpm --filter @buttery/lexicons build` first if `src/generated` stale.
- Both servers share one database. Not isolated.
- Kill when done (Ctrl-C, or `pkill -f "vite dev --port 3100"`). Not supervised, so nothing else will.

## Clearing logs

`pnpm dev` wipe `.dev-logs/*.log` on fresh boot only. `process restart web` does NOT clear anything — clear by hand.

```bash
process-compose process logs truncate web   # in-memory buffer only — the file survives
: > .dev-logs/web.log                        # the file; safe while the process is running
```

**Order matter.** Clear, THEN trigger, THEN read:

```bash
process-compose process restart web
process-compose project is-ready --wait
process-compose process logs truncate web && : > .dev-logs/web.log   # clear AFTER boot noise
# …now load the page…
process-compose process logs web -n 50
```

Clear after request = throw away evidence. Clear before restart = boot chatter mixed in. Empty log prove nothing — when need proof, capture boot + request together.

## Cleanup

```bash
pnpm dev:down          # stop the stack AND the railway dev containers
process-compose down   # stop the stack only — containers keep running
railway dev clean      # ALSO wipes the postgres volume; next `pnpm dev` re-migrates
```

`process-compose down` alone leave Postgres/Redis/Caddy up: detached docker containers, process-compose only tail their logs.

## Gotchas

- `curl` return `000` have TWO causes: stack down, or command sandbox blocking `localhost:3000`. Run `process-compose project state` BEFORE blaming sandbox — else you assert "sandbox" at dead server, walk it back later. Stack up + `000` = sandbox: verify pages with Chrome MCP tools, run DB-touching commands with sandbox disabled.
- macOS `grep` treat curl'd SSR HTML as **binary** (one huge line, UTF-8 punctuation) and exit 1 silently — looks exactly like a real miss. Always `grep -a` on fetched HTML, else every content assertion lie.
- Vite auto-bump 3000 → 3001 if port busy. Check `.dev-logs/web.log` for real URL; usual cause = second dev server someone forgot to kill.
- Browse **http://127.0.0.1:3000**, never `localhost` — atproto loopback client and session cookie bound to `127.0.0.1`.