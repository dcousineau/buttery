# Buttery

Your recipes, your pantry — kept as portable [atproto](https://atproto.com) records you can take anywhere. Buttery is a [TanStack Start](https://tanstack.com/start) web app backed by Postgres, with a cron service that syncs recipe records from the atmosphere.

The monorepo has two services:

- `services/web` — the app (`@buttery/web`)
- `services/atproto-cron-sync` — the periodic sync/backfill worker (`@buttery/atproto-cron-sync`)

## Local development

Requires [Docker](https://www.docker.com/) (for the local Postgres) and [mise](https://mise.jdx.dev/), which manages the Node, pnpm, and Railway CLI versions this repo pins in `mise.toml`.

```bash
# Install mise (macOS/Linux). See https://mise.jdx.dev/installing-mise.html for other options.
curl https://mise.run | sh

# Install the pinned toolchain (Node, pnpm, Railway CLI) and run repo setup hooks
mise install

pnpm install

# Start local Postgres + inject DATABASE_URL (Railway local emulation)
railway dev            # `railway dev down` to stop, `railway dev clean` to wipe data

# Run migrations against the dev DB
railway run --service buttery -- pnpm --filter=@buttery/web db:migrate:up

# Start the app on http://localhost:3000
pnpm dev
```

`railway run --service <svc> --` injects the Railway dev environment (`DATABASE_URL`, atproto credentials, etc.) into the wrapped command.

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
