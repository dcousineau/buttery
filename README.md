# Buttery

Your recipes, your pantry — kept as portable [atproto](https://atproto.com) records you can take anywhere. Buttery is a [TanStack Start](https://tanstack.com/start) web app backed by Postgres, with a cron service that syncs recipe records from the atmosphere.

The monorepo has two services:

- `services/web` — the app (`@buttery/web`)
- `services/atproto-cron-sync` — the periodic sync/backfill worker (`@buttery/atproto-cron-sync`)

## Local development

Requires [Docker](https://www.docker.com/) (for the local Postgres) and [mise](https://mise.jdx.dev/), which manages the Node, pnpm, Railway CLI, and process-compose versions this repo pins in `mise.toml`.

```bash
# Install mise (macOS/Linux). See https://mise.jdx.dev/installing-mise.html for other options.
curl https://mise.run | sh

# Install the pinned toolchain (Node, pnpm, Railway CLI, process-compose) and run repo setup hooks
mise install

pnpm install

# Boot the whole stack on http://127.0.0.1:3000
pnpm dev
```

`pnpm dev` supervises the whole stack — Railway dev containers, migrations, the atproto dev-env, and the web server — as one singleton [process-compose](https://f1bonacc1.github.io/process-compose/) project. In its TUI: arrow keys select a process, `F5` restarts it, `F10` quits.

Drive the same running stack from another terminal (or an agent):

```bash
pnpm dev:attach                    # attach the TUI to the running stack
pnpm dev:down                      # stop the stack and the containers

process-compose process list       # status + health of every process
process-compose process logs web   # or grep .dev-logs/<process>.log
process-compose process restart web
```

Run a one-off command against the dev services:

```bash
railway run --service buttery -- pnpm --filter=@buttery/web db:migrate:up
```

See [docs/LOCAL-DEV.md](./docs/LOCAL-DEV.md) for what each process is and how the pieces fit together.

### Running Claude Code sandboxed

Run unattended agent sessions inside [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime). `mise install` provides the `srt` binary.

```bash
# One-time: create your local config (gitignored) from the example, then edit
cp .srt-settings.json.example .srt-settings.json

# One-time: mint a long-lived token so sandboxed sessions skip the login prompt.
# Run this OUTSIDE the sandbox — it opens a browser. Then export it (shell profile,
# not this repo).
claude setup-token
export CLAUDE_CODE_OAUTH_TOKEN=<token>

# Check the config without starting a session — exit 0 means it validates
srt --settings ./.srt-settings.json /usr/bin/true

srt --settings ./.srt-settings.json claude -p "<task>" --dangerously-skip-permissions
```

Use print mode (`-p`). The interactive TUI does not work under `srt` — it cannot enter raw mode, so keystrokes buffer and the display corrupts. `--settings` must be passed explicitly, or the runtime silently falls back to a default config.

Without `CLAUDE_CODE_OAUTH_TOKEN` a sandboxed session asks you to log in every time: your credentials live in the macOS Keychain, which the example denies read on. See [docs/AGENT-SANDBOXING.md](./docs/AGENT-SANDBOXING.md#authenticating-without-opening-the-keychain).

See [docs/AGENT-SANDBOXING.md](./docs/AGENT-SANDBOXING.md) for what the example grants, why the config stays untracked, and when a container or VM is the better boundary.

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
