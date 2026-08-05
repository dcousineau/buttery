# Agent notes: verifying local ATProto publishes

To confirm an `exchange.recipe.recipe` publish worked **locally** (dev only,
isolated from the real network), use this service — do **not** query the real
network, and note buttery's own app never reads from this dev PDS.

Prereq: the dev-env must be running — root `pnpm dev` (and therefore
`railway dev up`) starts it alongside the web app; standalone is
`pnpm --filter @buttery/atproto-dev-env start`.
State is in-memory, so the did:plc changes every restart — always resolve the
handle → did at runtime; never hardcode a did.

## Verify a publish (read-only)

```sh
pnpm -s --filter @buttery/atproto-dev-env records
```

Deterministic output to assert on:

```
DID did:plc:...
COUNT <n>
RECORD <rkey>\t<name>\t<updatedAt>
```

## Seed a record for an autonomous loop (no OAuth)

```sh
pnpm --filter @buttery/atproto-dev-env seed -- --name "Assertable Name"
```

Then re-run `records` and assert the name appears and `COUNT` incremented. This
seeder writes the same collection + required fields as the app, so the read
helper and `@buttery/atproto-cron-sync` treat it identically.

## Confirm it reaches Postgres (via cron)

```sh
DID=$(pnpm -s --filter @buttery/atproto-dev-env records | sed -n 's/^DID //p')
railway run --service buttery -- env \
  ATPROTO_PLC_URL=http://localhost:2582 SYNC_ONLY_DID="$DID" \
  node services/atproto-cron-sync/src/main.ts --once
```

Then check the row via the `postgres` MCP (`mcp__postgres__execute_sql`).
