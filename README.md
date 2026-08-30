# Buttery

Your recipes, your pantry — kept as portable [atproto](https://atproto.com) records you can take anywhere. Buttery is a [TanStack Start](https://tanstack.com/start) web app backed by Postgres, with a background pipeline that syncs recipe records from the atmosphere.

The monorepo has two deployed services:

- `services/web` — the app (`@buttery/web`)
- `services/pipeline` — the BullMQ workflows, their Bull Board UI, and the autoscaled worker fleet (`@buttery/pipeline`)

## Local development

Requires [Docker](https://www.docker.com/) (for the local Postgres and Redis) and [mise](https://mise.jdx.dev/), which installs the Node and pnpm versions declared in `package.json` (`devEngines.runtime` and `packageManager`) plus the Railway CLI and process-compose versions pinned in `mise.toml`. Local dev runs entirely on the repo's own `docker-compose.yml` — no Railway login or auth is needed to boot the stack (Railway stays for deploys and the remote blob bucket only).

```bash
# Install mise (macOS/Linux). See https://mise.jdx.dev/installing-mise.html for other options.
curl https://mise.run | sh

# Install the pinned toolchain (Node, pnpm, Railway CLI, process-compose) and run repo setup hooks
mise install

pnpm install

# Boot the whole stack on http://127.0.0.1:3000
pnpm dev
```

`services/web/.env` holds the web service's configuration. `mise install` and `pnpm dev` both create it from `services/web/.env.example` when it is missing, generating a throwaway `BETTER_AUTH_SECRET`; the `DATABASE_URL` / `REDIS_URL` defaults already match `docker-compose.yml`, so a first boot needs nothing else. An existing `.env` is never overwritten. To do it by hand instead: `cp services/web/.env.example services/web/.env`, then set `BETTER_AUTH_SECRET` to `openssl rand -base64 32`.

**Regenerating config after a pull.** Because an existing `.env` is never overwritten, a pull that adds a key to a `.env.example` leaves your rendered file stale and quietly missing that key. To re-render everything from the committed templates — both services' `.env` and `.mcp.json`:

```sh
mise run setup:reset
```

It renames each file it replaces to `<name>.bak.<timestamp>` beside itself (gitignored) before writing, so any hand-edited value is still there to copy back — check the backup for real blob-storage credentials or a pinned secret. `-- --dry-run` shows what it would move; `-- --no-backup` deletes instead. The regenerated `services/web/.env` gets a fresh `BETTER_AUTH_SECRET`, which signs you out of the local dev server.

`pnpm dev` supervises the whole stack — the docker-compose containers (Postgres + Redis), migrations, the atproto dev-env, the web server, and the BullMQ pipeline pair — as one singleton [process-compose](https://f1bonacc1.github.io/process-compose/) project. In its TUI: arrow keys select a process, `F5` restarts it, `F10` quits.

Drive the same running stack from another terminal:

```bash
pnpm dev:attach                    # attach the TUI to the running stack
pnpm dev:down                      # stop the stack, containers included

process-compose process list       # status + health of every process
process-compose process start docs # the docs site (port 3001) is opt-in, off by default
process-compose process logs web   # or grep .dev-logs/<process>.log
process-compose process restart web
```

Agents should use the `pc_*` MCP tools instead — the running stack serves them from `localhost:8098`, registered as the `process-compose` server in `.mcp.json`.

`.mcp.json` is generated, not committed: `mise install` renders it from `.mcp.json.example` when the file is missing, baking in the dev database URL from `services/web/.env` (rewritten to the docker gateway host the containerized postgres MCP needs). It leaves an existing `.mcp.json` alone — run `mise run setup:mcp -- --force` to re-render after the dev database URL changes or after `.mcp.json.example` gains a server. MCP clients read the file once at startup, so a rewrite lands on their next session.

Run a one-off migration against the dev database (reads `DATABASE_URL` from `services/web/.env`, no Railway needed):

```bash
pnpm --filter=@buttery/web db:migrate:up
```

Run the tests:

```bash
pnpm test        # unit tests; needs nothing running
pnpm test:db     # *.db.test.ts integration suites against the dev Postgres (stack must be up)
```

`pnpm test` skips the DB suites when there is no database rather than failing.

See [docs/LOCAL-DEV.md](./docs/LOCAL-DEV.md) for what each process is and how the pieces fit together.

## Data pipelines

Background jobs run on [BullMQ](https://docs.bullmq.io) over the same Redis the app uses. The stack boots a producer + [Bull Board](https://github.com/felixmosh/bull-board) UI on <http://127.0.0.1:3002/ui> and a worker that drains every queue; on Railway those are two services, and the worker fleet is autoscaled on queue depth.

```bash
# Enqueue a demo job and watch it move through the board
curl -X POST http://127.0.0.1:3002/jobs/demo \
  -H 'content-type: application/json' \
  -d '{"data": {"durationMs": 5000, "label": "hello"}}'

# Run several workers against one queue, the way replicas do on Railway
process-compose process scale pipeline-worker 3
```

See [services/pipeline/README.md](./services/pipeline/README.md) for how to add a workflow and how the autoscaler decides.

## Backfill / sync

The atproto sweep pulls recipe records into Postgres. In production it runs hourly as the `atproto-sync` BullMQ workflow (there is no Railway cron service any more); locally it stays manual. Every way of running it reads `services/pipeline/.env` (created for you by `pnpm dev`), so no wrapper is needed — but the dev stack has to be up.

```bash
# One sweep of the real atmosphere into the local DB (writes)
pnpm --filter=@buttery/pipeline sync:trigger

# Fetch + log without writing
pnpm --filter=@buttery/pipeline sync:trigger --dry-run

# One sweep of the LOCAL atproto dev-env instead — a disabled process-compose
# one-shot; run it after publishing a recipe locally
process-compose process start atproto-sync

# The same sweep through the queue, so you can watch it in the Bull Board UI
curl -X POST http://127.0.0.1:3002/jobs/atproto-sync -d '{}' -H 'content-type: application/json'
```

To run it on a clock locally too, set `ATPROTO_SYNC_SCHEDULE` in `services/pipeline/.env` and restart the `pipeline` process.

## License

Buttery is released under the [GNU Affero General Public License v3.0](./LICENSE).

Copyright (C) 2026 Daniel Cousineau
