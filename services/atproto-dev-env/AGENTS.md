# Agent notes: verifying local ATProto publishes

Confirm `exchange.recipe.recipe` publish worked **locally** (dev only, isolated from real network) with this service. Do **not** query real network. Buttery's own app never reads from this dev PDS.

Prereq: dev-env must run — root `pnpm dev` starts it alongside web app (process-compose runs both). Standalone: `pnpm --filter @buttery/atproto-dev-env start`.
State persists in `.dev-data/atproto/`, so seed account keeps one stable did:plc across restarts. Still resolve handle → did at runtime, no hardcode: did changes whenever that directory deleted, and `records` helper already prints it.

## The dev account — where its handle, password, and did come from

Never hardcode. Defaults in `src/config.ts` (`loadConfig`), each env-overridable. Read at runtime from boot banner runner prints — only source reflecting env actually in effect:

```sh
grep -E "Handle:|Pass:|DID:|PDS:" .dev-logs/atproto-dev-env.log | tail -4
```

Or off MCP server, no filesystem touch — `pc_process_logs_search {name: "atproto-dev-env", query: "Handle DID Pass PDS"}`.

```
Handle: chef.test
DID:    did:plc:...   (stable — restored)
Pass:   devpw-chef-000
PDS:    http://localhost:2583
```

Defaults + overriding env vars: `ATPROTO_DEV_HANDLE` → `chef.test`, `ATPROTO_DEV_PASSWORD` → `devpw-chef-000`, `ATPROTO_DEV_EMAIL` → `chef@dev.local`. Did derived, not configured — get from banner or `records` (below), never from doc.

Password is throwaway for isolated local PDS, unreachable from real atmosphere, holds nothing of value. Still a credential in a form field — see handoff note in sign-in section.

## Sign in to the app as the dev account (claude-in-chrome)

Only needed when thing under test is **app's** OAuth/publish path. To assert on records, skip browser, use `records` / `seed` below — no OAuth, no browser.

Preconditions: stack up, both `web` and `atproto-dev-env` `Ready`. Check with process-compose MCP tools — `pc_project_state`, then `pc_process_list` (or `pc_project_is_ready` for whole-stack answer).

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

Session survives `atproto-dev-env` restart now that state persists — handoff once per `.dev-data/atproto/`, not per restart.

Debugging: `Failed to resolve OAuth server metadata for resource:
http://localhost:2583/` in browser means app did not classify itself as loopback, so `allowHttp` stayed off. Real cause shows under `[cause]` in `web` logs (`pc_process_logs_search {name:"web", query:"cause"}`, or grep `.dev-logs/web.log`), not in HTTP response — usually non-loopback `BETTER_AUTH_URL` — `services/web/.env` pins it to `http://127.0.0.1:3000` (`vite.config.ts` loads `.env` into process.env for dev; that pin is what keeps the server loopback now that `railway run` no longer injects the production value). Check handshake without browser first:

```sh
curl -s -X POST http://127.0.0.1:3000/api/auth/atproto/sign-in \
  -H 'Content-Type: application/json' -d '{"handle":"chef.test"}'
```

`{"url":"http://localhost:2583/oauth/authorize?…"}` response means server side fine, problem in browser step.

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

Re-run `records`, assert name appears and `COUNT` incremented. Seeder writes same collection + required fields as app, so read helper and `@buttery/worker` treat it identically.

## Confirm it reaches Postgres (via cron)

```sh
DID=$(pnpm -s --filter @buttery/atproto-dev-env records | sed -n 's/^DID //p')
railway run --service buttery -- env \
  ATPROTO_PLC_URL=http://localhost:2582 SYNC_ONLY_DID="$DID" \
  pnpm --filter @buttery/worker sync:once
```

Check row via `postgres` MCP (`mcp__postgres__execute_sql`).
