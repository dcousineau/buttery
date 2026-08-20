# `@buttery/atproto-cron-sync`

Sweeps the atproto network for `exchange.recipe.recipe` records and mirrors them
into Buttery's Postgres index (`atproto_repo` / `atproto_collection_recipe` /
`atproto_sync_run`). Stage 1 of the ingestion strategy: index-on-write + periodic
reconciliation, no Tap yet. See
[`docs/plans/01-atproto-cron-sync-service.md`](../../docs/plans/01-atproto-cron-sync-service.md).

> **"cron" in the name is historical.** This was a Railway cron service; the
> schedule now lives in BullMQ as the `atproto-sync` pipeline in
> [`@buttery/pipeline`](../pipeline/README.md), which imports `runSweep` from
> here and runs it hourly on the autoscaled worker fleet. The sweep itself did
> not move, and neither did its configuration: `.env` in this directory still
> decides which network gets swept, whoever is driving it.

Two ways to run a sweep, and they do the same thing:

- **Scheduled / on demand** — the `atproto-sync` pipeline. Visible in the Bull
  Board UI while it runs, and triggerable with
  `curl -X POST http://127.0.0.1:3002/jobs/atproto-sync`.
- **By hand** — `pnpm --filter @buttery/atproto-cron-sync sync:once`, the CLI in
  `src/main.ts`. Still the fastest way to iterate on the sweep itself.

`src/index.ts` is the package's public surface (`loadConfig`, `runSweep`,
`closeDb`); everything else under `src/` is internal.

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
6. Write an `atproto_sync_run` summary. The CLI then ends the pool and exits;
   under the pipeline the pool is kept for the next sweep and ended when the
   worker drains.

## Local run

> **Sandbox caveat:** the dev DB host and the atproto network hosts are not in
> the command sandbox allowlist. Run these with a real-network shell (the `!`
> prefix in the prompt), not a sandboxed call.

No `railway run` anywhere: `pnpm dev` boots the local stack (Postgres, migrations,
the atproto dev-env), and this service reads `services/atproto-cron-sync/.env` —
created from `.env.example` by the same bootstrap that creates `services/web/.env`.

```bash
pnpm --filter @buttery/atproto-cron-sync sync:once
pnpm --filter @buttery/atproto-cron-sync sync:once --dry-run   # fetch + log, no writes
SYNC_MAX_REPOS=25 pnpm --filter @buttery/atproto-cron-sync sync:once   # partial, fast

# Same run, supervised — a disabled one-shot in process-compose, so it also
# shows up in the TUI and logs to .dev-logs/atproto-cron-sync.log
process-compose process start atproto-cron-sync
```

**`.env` decides which network a sweep reads**, and both invocations obey it
identically. The defaults are the real atmosphere (`plc.directory` + the public
relay) — a live sync into the local database. To sweep the local atproto dev-env
instead, set `ATPROTO_PLC_URL=http://localhost:2582` and
`SYNC_PDS_URL=http://localhost:2583` there, then re-run after each local publish;
every sweep is idempotent. (The environment still outranks the file, since
`process.loadEnvFile` never overwrites an already-set var — handy for a one-off
`SYNC_ONLY_DID=… pnpm …`, and how Railway supplies everything in production.)

The tables live in web's migration pipeline, so a fresh database needs
`pnpm --filter @buttery/web db:migrate:up` first — which is what the stack's
`migrate` process does on every boot.

Integration tests against that same database:
`pnpm --filter @buttery/atproto-cron-sync test:db` (bare `vitest`; the `.env`
supplies `DATABASE_URL`, and the suites skip when there's no database).

## Flags / env

| Flag / env         | Effect                                                                         |
| ------------------ | ------------------------------------------------------------------------------ |
| `--once`           | Accepted for symmetry; one sweep per invocation is the only mode.              |
| `--dry-run`        | Fetch + log, no writes. Good for measuring sweep size/duration.                |
| `SYNC_MAX_REPOS=N` | Stop after N DIDs — fast partial bootstrap.                                    |
| `SYNC_ONLY_DID=…`  | Sync a single DID — debugging one repo.                                        |
| `SYNC_CONCURRENCY` | Per-DID pool size (default 8).                                                 |
| `RELAY_URL`        | Override the enumeration relay.                                                |
| `SYNC_PDS_URL`     | Enumerate one PDS's `listRepos` instead of the relay — the local dev-env mode. |
| `ATPROTO_PLC_URL`  | Override DID-document resolution (dev-env's PLC locally).                      |

A partial sweep (`SYNC_MAX_REPOS` / `SYNC_ONLY_DID` / `SYNC_PDS_URL`) does
**not** drive missing-repo or network-wide delete reconciliation — it hasn't
observed the whole network.

`SYNC_PDS_URL` exists because the dev-env ships no relay and its PDS rejects
unauthenticated `com.atproto.sync.listReposByCollection` with `AuthMissing`;
`com.atproto.sync.listRepos` on that PDS is the unauthenticated way in. It is not
collection-filtered, so point it at a dev PDS, never at a real one.
