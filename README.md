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

# Start the external services — Postgres and Redis only, never the app itself.
# Prints a config overview (host ports, connection info); re-run any time to see it again.
railway dev            # `railway dev down` to stop, `railway dev clean` to wipe data

# Run migrations against the dev DB
railway run --service buttery -- pnpm --filter=@buttery/web db:migrate:up

# Start the app on http://127.0.0.1:3000
railway run --service buttery -- pnpm dev
```

`railway run --service <svc> --` injects the local service variables (`DATABASE_URL`, `REDIS_URL`, atproto credentials, etc.) into the wrapped command. Since `railway dev` never starts the app, dev servers are always launched separately like this.

### Running Claude Code sandboxed

Run unattended agent sessions inside [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime):

```bash
# One-time: copy the repo's starting config to your home directory, then edit
cp .srt-settings.json.example ~/.srt-settings.json

npx @anthropic-ai/sandbox-runtime --settings ~/.srt-settings.json claude
```

The settings file must live outside the repo, and `--settings` must be passed explicitly. See [docs/AGENT-SANDBOXING.md](./docs/AGENT-SANDBOXING.md) for why, for what the example grants, and for when a container or VM is the better boundary.

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
