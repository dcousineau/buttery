# `@buttery/atproto-cron-sync`

A **cron service** that periodically sweeps the atproto network for
`exchange.recipe.recipe` records and mirrors them into Buttery's Postgres index
(`atproto_repo` / `atproto_collection_recipe` / `atproto_sync_run`). Stage 1 of the ingestion strategy:
index-on-write + cron reconciliation, no Tap yet. See
[`docs/plans/01-atproto-cron-sync-service.md`](../../docs/plans/01-atproto-cron-sync-service.md).

- Plain Node (`node = 26`), TypeScript run directly via type-stripping — **no
  build step**. Every source file is erasable-only TS (no `enum`/`namespace`/
  param-properties).
- Only runtime dep is **`pg`** (same version as `@buttery/web`).
- **Pure writer.** The tables live in the web package's Kysely migration
  pipeline; web owns DDL and runs `db:migrate:up` at deploy. This service writes
  them with hand-written raw SQL.
- **Idempotent, stateless between runs.** Each sweep re-enumerates the whole
  network. Every write is a rev-guarded upsert keyed on `(did, rkey)`.

## Sweep algorithm

1. Enumerate DIDs — `com.atproto.sync.listReposByCollection` on the relay.
2. Resolve each DID → PDS (cached on `atproto_repo.pds`).
3. Page `com.atproto.repo.listRecords` per DID (unauthenticated).
4. Rev-guarded upsert per record into `atproto_collection_recipe` (raw JSON + projection).
5. Soft-delete rows absent from a DID's full, successful enumeration.
6. Write an `atproto_sync_run` summary, end the pool, `exit(0/1)`.

## Local run / bootstrapping the DB

> **Sandbox caveat:** the dev DB host and the atproto network hosts are not in
> the command sandbox allowlist. Run these with a real-network shell (the `!`
> prefix in the prompt), not a sandboxed call.

One-time:

```bash
mise install                 # node / pnpm / railway
pnpm install                 # wires up this workspace package
# create the tables via the web migration pipeline (web owns DDL):
railway run --service buttery -- pnpm --filter @buttery/web db:migrate:up
railway run --service buttery -- pnpm --filter @buttery/web db:codegen
```

Run a sweep (`DATABASE_URL` must point at the target DB — easiest is to let
Railway inject it):

```bash
# full network sweep:
railway run --service atproto-cron-sync -- pnpm --filter @buttery/atproto-cron-sync sync:once

# fast partial bootstrap while iterating (cap repos):
SYNC_MAX_REPOS=25 railway run --service atproto-cron-sync -- pnpm --filter @buttery/atproto-cron-sync sync:once

# dry run — hit the network, log what would be written, touch nothing:
railway run --service atproto-cron-sync -- pnpm --filter @buttery/atproto-cron-sync start -- --once --dry-run
```

Or, with a local `services/atproto-cron-sync/.env` holding `DATABASE_URL`
(`config.ts` calls `process.loadEnvFile()`), run directly:
`pnpm --filter @buttery/atproto-cron-sync sync:once`. There's also `mise run sync`.

## Flags / env

| Flag / env         | Effect                                                            |
| ------------------ | ----------------------------------------------------------------- |
| `--once`           | Accepted for symmetry; one sweep per invocation is the only mode. |
| `--dry-run`        | Fetch + log, no writes. Good for measuring sweep size/duration.   |
| `SYNC_MAX_REPOS=N` | Stop after N DIDs — fast partial bootstrap.                       |
| `SYNC_ONLY_DID=…`  | Sync a single DID — debugging one repo.                           |
| `SYNC_CONCURRENCY` | Per-DID pool size (default 8).                                    |
| `RELAY_URL`        | Override the enumeration relay.                                   |

A partial sweep (`SYNC_MAX_REPOS` / `SYNC_ONLY_DID`) does **not** drive
missing-repo or network-wide delete reconciliation — it hasn't observed the
whole network.
