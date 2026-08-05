# Agent notes: verifying local ATProto publishes

To confirm an `exchange.recipe.recipe` publish worked **locally** (dev only,
isolated from the real network), use this service — do **not** query the real
network, and note buttery's own app never reads from this dev PDS.

Prereq: the dev-env must be running — root `pnpm dev` (and therefore
`railway dev up`) starts it alongside the web app; standalone is
`pnpm --filter @buttery/atproto-dev-env start`.
State persists in `.dev-data/atproto/`, so the seed account keeps one stable
did:plc across restarts. Still resolve handle → did at runtime rather than
hardcoding one: the did changes whenever that directory is deleted, and the
`records` helper already prints it.

## The dev account — where its handle, password, and did come from

Never hardcode these. Defaults live in `src/config.ts` (`loadConfig`) and each is
overridable by env, so read them at runtime from the boot banner the runner
prints — it is the one source that reflects the env actually in effect:

```sh
grep -E "Handle:|Pass:|DID:|PDS:" .dev-logs/atproto-dev-env.log | tail -4
```

```
Handle: chef.test
DID:    did:plc:...   (stable — restored)
Pass:   devpw-chef-000
PDS:    http://localhost:2583
```

Defaults, and the env vars that override them: `ATPROTO_DEV_HANDLE` →
`chef.test`, `ATPROTO_DEV_PASSWORD` → `devpw-chef-000`, `ATPROTO_DEV_EMAIL` →
`chef@dev.local`. The did is derived, not configured — get it from the banner or
from `records` (below), never from a doc.

The password is a throwaway for an isolated local PDS that is unreachable from
the real atmosphere and holds nothing of value. It is still a credential in a
form field, so see the handoff note in the sign-in section.

## Sign in to the app as the dev account (claude-in-chrome)

Only needed when the thing under test is the **app's** OAuth/publish path. To
assert on records, skip the browser entirely and use `records` / `seed` below —
they need no OAuth and no browser.

Preconditions: the stack is up (`process-compose project state`), and `web` and
`atproto-dev-env` are both `Ready` (`process-compose process list -o wide`).

1. `mcp__claude-in-chrome__tabs_context_mcp`, then `tabs_create_mcp` — do not
   reuse a tab id from an earlier session.
2. Navigate to **`http://127.0.0.1:3000`**, never `localhost:3000`. The atproto
   loopback client and the session cookie are both bound to `127.0.0.1`; the two
   origins do not share a session and OAuth will build redirects for the wrong one.
3. Click sign in, enter the handle (`chef.test`) in the handle field, submit.
   The app redirects to the local PDS's own authorize page on `localhost:2583`.
4. The PDS asks for the account password. **Stop here and hand this step to the
   human** — quote them the `Pass:` line from the banner and ask them to type it.
   Entering a password into a form is not something to automate, and the value is
   already on their screen in the banner.
5. After they submit, click through the PDS consent screen, land back on
   `127.0.0.1:3000`, and carry on driving the app.

The session survives an `atproto-dev-env` restart now that state persists, so
this handoff is once per `.dev-data/atproto/`, not once per restart.

Debugging: a `Failed to resolve OAuth server metadata for resource:
http://localhost:2583/` in the browser means the app did not classify itself as
loopback, so `allowHttp` stayed off. The real cause is in `.dev-logs/web.log`
under `[cause]`, not in the HTTP response — usually a non-loopback
`BETTER_AUTH_URL` (Railway injects the production one and its values beat
`.env`, which is why `process-compose.yaml` re-overrides it on the `web` child
command). Check the handshake without a browser first:

```sh
curl -s -X POST http://127.0.0.1:3000/api/auth/atproto/sign-in \
  -H 'Content-Type: application/json' -d '{"handle":"chef.test"}'
```

A `{"url":"http://localhost:2583/oauth/authorize?…"}` response means the server
side is fine and the problem is in the browser step.

The post-login `invited` gate does not apply in dev: `isInvited` returns true
whenever `NODE_ENV` is `development` or `test`, without consulting PostHog, so
any signed-in dev account reaches the app.

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
