# Buttery

Your recipes, your pantry — kept as portable [atproto](https://atproto.com) records you can take anywhere. Buttery is a [TanStack Start](https://tanstack.com/start) web app backed by Postgres, with a cron service that syncs recipe records from the atmosphere.

The monorepo has two services:

- `services/web` — the app (`@buttery/web`)
- `services/atproto-cron-sync` — the periodic sync/backfill worker (`@buttery/atproto-cron-sync`)

## Local development

Requires [Docker](https://www.docker.com/) (for the local Postgres and Redis) and [mise](https://mise.jdx.dev/), which installs the Node and pnpm versions declared in `package.json` (`devEngines.runtime` and `packageManager`) plus the Railway CLI and process-compose versions pinned in `mise.toml`. Local dev runs entirely on the repo's own `docker-compose.yml` — no Railway login or auth is needed to boot the stack (Railway stays for deploys and the remote blob bucket only).

```bash
# Install mise (macOS/Linux). See https://mise.jdx.dev/installing-mise.html for other options.
curl https://mise.run | sh

# Install the pinned toolchain (Node, pnpm, Railway CLI, process-compose) and run repo setup hooks
mise install

pnpm install

# Configure the web service. Copy the template, then fill in BETTER_AUTH_SECRET
# (openssl rand -base64 32). The DATABASE_URL / REDIS_URL defaults already match
# docker-compose.yml, so nothing else is required for a first boot.
cp services/web/.env.example services/web/.env

# Boot the whole stack on http://127.0.0.1:3000
pnpm dev
```

`pnpm dev` supervises the whole stack — the docker-compose containers (Postgres + Redis), migrations, the atproto dev-env, and the web server — as one singleton [process-compose](https://f1bonacc1.github.io/process-compose/) project. In its TUI: arrow keys select a process, `F5` restarts it, `F10` quits.

Drive the same running stack from another terminal:

```bash
pnpm dev:attach                    # attach the TUI to the running stack
pnpm dev:down                      # stop the stack and the containers

process-compose process list       # status + health of every process
process-compose process start docs # the docs site (port 3001) is opt-in, off by default
process-compose process logs web   # or grep .dev-logs/<process>.log
process-compose process restart web
```

Agents should use the `pc_*` MCP tools instead — the running stack serves them from `localhost:8098`, registered as the `process-compose` server in `.mcp.json` (copy `.mcp.json.example` if you don't have one).

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

## Backfill / sync

The cron sync pulls recipe records from the atmosphere into Postgres. Run one sweep manually with the cron service's environment:

```bash
# One sweep (writes to the DB)
railway run --service atproto-cron-sync -- pnpm --filter=@buttery/atproto-cron-sync sync:once

# Fetch + log without writing
railway run --service atproto-cron-sync -- pnpm --filter=@buttery/atproto-cron-sync sync:once --dry-run
```

## License

Buttery is released under the [GNU Affero General Public License v3.0](./LICENSE).

Copyright (C) 2026 Daniel Cousineau
