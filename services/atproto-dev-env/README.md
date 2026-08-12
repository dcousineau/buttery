# @buttery/atproto-dev-env

A **local-only** ATProto network for testing recipe publishing without touching
the real atmosphere. Wraps [`@atproto/dev-env`](https://github.com/bluesky-social/atproto/tree/main/packages/dev-env)
`TestNetworkNoAppView` to run an isolated **PDS + local PLC** (no AppView, no
relay). DIDs are registered in the local PLC and the PDS is local, so nothing is
visible to `plc.directory`, `bsky.social`, or the relay.

> Local dev only. **Not** deployed to Railway (absent from `.railway/railway.ts`).

## Run it

Root `pnpm dev` starts it alongside the web app (process-compose runs both as
part of the one dev stack):

```sh
pnpm dev          # atproto dev-env + web
pnpm dev:web      # web only
```

Standalone:

```sh
pnpm --filter @buttery/atproto-dev-env start
```

On boot it seeds one `.test` account and prints the block to paste into
`services/web/.env`:

```
ATPROTO_HANDLE_RESOLVER=http://localhost:2583
ATPROTO_PLC_URL=http://localhost:2582
ATPROTO_PUBLISH_ENABLED=true
```

Then run buttery (`pnpm dev`), sign in with the seed handle (default `chef.test`)
and its printed password, and publish a recipe — it lands in the local PDS.

> **Persistent:** state lives in `.dev-data/atproto/` (gitignored) — the PDS
> sqlite + blobstore, and a snapshot of the local PLC. The seed account keeps
> **one stable did:plc** across restarts, so buttery's Postgres rows stay
> resolvable and a browser session survives a dev-env restart.
>
> Delete `.dev-data/atproto/` to start over; the next boot mints a new did:plc,
> which orphans any buttery row pointing at the old one.
>
> Override the location with `ATPROTO_DEV_DATA_DIR`. Stability also depends on
> the pinned rotation key and JWT secret in `src/config.ts` — the DID is derived
> from the genesis operation that key signs, so a random key would change the
> DID even with a persistent PLC. Both are dev-only throwaways.

## Helpers (talk to the running dev-env over HTTP)

```sh
# Write a valid exchange.recipe.recipe record (autonomous, no OAuth):
pnpm --filter @buttery/atproto-dev-env seed
pnpm --filter @buttery/atproto-dev-env seed -- --name "Test Stew"

# Read records back (read-only; the agent verify path):
pnpm --filter @buttery/atproto-dev-env records
```

`seed` is a **verification seeder**, not buttery's real publish path (that's
the app's OAuth flow). It exists so a test-eval loop can seed a known record and
confirm the read + cron pipeline without a human.

## Config (env, all optional)

| Var                    | Default          | Meaning               |
| ---------------------- | ---------------- | --------------------- |
| `ATPROTO_DEV_PDS_PORT` | `2583`           | PDS port              |
| `ATPROTO_DEV_PLC_PORT` | `2582`           | local PLC port        |
| `ATPROTO_DEV_HANDLE`   | `chef.test`      | seed account handle   |
| `ATPROTO_DEV_EMAIL`    | `chef@dev.local` | seed account email    |
| `ATPROTO_DEV_PASSWORD` | `devpw-chef-000` | seed account password |

## Verify the whole loop (publish → read → cron → DB)

```sh
pnpm --filter @buttery/atproto-dev-env start          # terminal 1
pnpm --filter @buttery/atproto-dev-env seed        # terminal 2
pnpm --filter @buttery/atproto-dev-env records        # confirm the record is present
# then sync it into the dev Postgres:
DID=$(pnpm -s --filter @buttery/atproto-dev-env records | sed -n 's/^DID //p')
railway run --service buttery -- env \
  ATPROTO_PLC_URL=http://localhost:2582 SYNC_ONLY_DID="$DID" \
  node services/atproto-cron-sync/src/main.ts --once
```
