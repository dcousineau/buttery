# `src/db`

Database schema, migrations, and fixtures.

- `types.ts` — Kysely schema types (`DB` interface). **Generated** by
  `kysely-codegen` (`pnpm db:codegen`); do not edit by hand.
- `migrations/` — schema migrations, run via `kysely-ctl`. The initial migration
  ports the full schema; apply with `pnpm db:migrate:up`.
- `seeds/` — kysely-ctl dev seeds. **Manual only**, never run automatically;
  apply with `pnpm db:seed:run`.
- `fixtures/` — seed / test data.

Runtime DB utilities (the Kysely instance, connection pool) live in `src/lib/db.ts`,
not here — this directory is schema/data definitions only.

## Migrations (kysely-ctl)

Config: `kysely.config.ts` (repo root) — reuses the app's shared pool from
`src/lib/db.ts` and loads `.env`.

- `pnpm db:migrate:up` — apply all pending migrations (`migrate latest`).
- `pnpm db:migrate:down` — roll back the last migration.
- `pnpm db:migrate:new <name>` — scaffold a new migration in `migrations/`.
- `pnpm db:migrate:list` — show migration status.

## Seeds (kysely-ctl)

Dev fixture data, same config file. Seeds are **only ever run by hand** — no
process, hook, or pre-deploy step invokes them, and none may be taught to. Unlike
migrations, kysely-ctl keeps **no ledger table** for seeds: `seed run` re-runs
every file in `seeds/` on every invocation, so a seed here must be idempotent.

- `pnpm db:seed:run` — run every seed in `seeds/`.
- `pnpm db:seed:make <name>` — scaffold a new seed (never hand-name the file;
  the timestamp prefix comes from the CLI, same as migrations).
- `pnpm db:seed:list` — list seed files.

## Resetting user data (`db:reset:users`)

`services/web/scripts/reset-user-data.ts` deletes every account- and
household-owned row — users, sessions, atproto OAuth sessions, households,
boxes, meal plans, grocery lists, import history, and `origin = 'local'`
recipes — while **keeping** the synced atproto corpus (`atproto_*` tables,
`origin = 'sync'` recipes and their children) and `recipe_vocab*`. Use it to
re-run onboarding from zero without paying for another `sync:once` sweep.

- `pnpm db:reset:users -- --dry-run` — run the deletes and roll back, printing
  per-table counts.
- `pnpm db:reset:users -- --yes` — actually do it.

Refuses a non-loopback `DATABASE_URL` unless `--allow-remote` is also passed,
and does nothing at all without `--yes`. Manual only, like the seeds: no
process, hook or task may call it. Blob-storage objects for deleted local
recipes are orphaned rather than removed.

## Type generation (kysely-codegen)

`types.ts` is introspected from the live local DB. A **dev-only** dependency —
never run in prod (migrations there are applied by the Railway pre-deploy).

- `pnpm db:codegen` — regenerate `src/db/types.ts` from the current DB schema.

kysely-codegen reads `DATABASE_URL` from `.env` (the same connection
`kysely.config.ts` uses). **Always run `pnpm db:codegen` right after
`pnpm db:migrate:up`** so the types match the schema; the bookkeeping
`kysely_migration*` tables are excluded from the output.
