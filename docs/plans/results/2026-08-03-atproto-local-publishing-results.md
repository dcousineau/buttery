# Results: Local ATProto publishing (dev-only)

> Plan: [`docs/plans/2026-08-03-atproto-local-publishing.md`](../2026-08-03-atproto-local-publishing.md)
> Branch: `feat/atproto-local-dev-publishing`
> Implemented 2026-08-03.

## Task-0 spike outcome (the gate) — PASS

Booted `@atproto/dev-env` `TestNetworkNoAppView` (v0.5.42) and probed it:

- **OAuth is served by the dev-env PDS.** `/.well-known/oauth-authorization-server`
  → 200 (issuer, `scopes_supported: [atproto, …]`, `response_types: [code]`);
  `/.well-known/oauth-protected-resource` → 200; `/oauth/authorize` → serves HTML
  (the login/consent UI). So buttery's OAuth-only login can complete locally.
- **`plcDirectoryUrl` is a valid `NodeOAuthClient` option** (flows through
  `OAuthClientOptions → CreateIdentityResolverOptions → DidPlcMethodOptions`,
  default `https://plc.directory/`, http allowed for local). Confirmed against the
  installed `@atproto/oauth-client-node@0.5.1`.
- **Local PLC isolation works.** `createAccount('chef.test')` minted a did:plc in
  the LOCAL PLC; resolving it via the local PLC returned the local PDS endpoint —
  no call to plc.directory.
- **Record round-trip works.** `createRecord` for `exchange.recipe.recipe` (with a
  pinned ULID rkey) then unauthenticated `listRecords` read it back.
- **No relay** in `TestNetworkNoAppView` (`NET_KEYS = plc,pds,feedGens`) — as the
  plan anticipated, the cron local mode uses `SYNC_ONLY_DID` (no enumeration).

## What shipped

| Area        | Change                                                                                                                                                                                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New service | `services/atproto-dev-env/` — wraps `TestNetworkNoAppView` (PDS :2583 + local PLC :2582), seeds `chef.test`, prints the `.env` block, stays alive. Helpers: `records` (read/verify), `seed` (programmatic publish). README + CLAUDE.md.                                                         |
| Web OAuth   | `oauth-node.ts`: `HANDLE_RESOLVER` ← `ATPROTO_HANDLE_RESOLVER` env; `NodeOAuthClient` gets `plcDirectoryUrl` from `ATPROTO_PLC_URL` when set. Prod defaults unchanged.                                                                                                                          |
| Web env     | `services/web/.env.example`: documented dev-only ATPROTO_* block.                                                                                                                                                                                                                               |
| Cron        | `atproto-cron-sync/identity.ts`: `plc.directory` ← `ATPROTO_PLC_URL` env. `SYNC_ONLY_DID` already bypasses the relay. Prod unchanged.                                                                                                                                                           |
| Tooling     | root `pnpm atproto:dev-env` script; `pnpm-workspace.yaml`: allow `better-sqlite3`/`sharp`/`protobufjs` builds; exempt `@atproto/*` + `@atproto-labs/*` from `minimumReleaseAge` (dev-env's transitive carets re-release as a batch and can't satisfy the age gate; the tool is never deployed). |

Script naming note: the publish helper's pnpm script is **`seed`**, not `publish` —
`pnpm … publish` collides with pnpm's built-in `publish` command and hijacks the
args. The source file is still `src/publish.ts`.

## Verification

- **Runner** boots and prints the env block; PDS listens on :2583. ✅
- **`seed`** writes a valid recipe (`name/text/ingredients/instructions/*At`); ✅
- **`records`** reads them back: `COUNT 2`, correct names. ✅
- **Full loop publish → local PDS → cron → Postgres:** ✅ Proven against a
  throwaway local Postgres (`postgres:16`, migrated with buttery's 11 kysely
  migrations, since the shared railway dev-DB tunnel was down — see below):

  ```
  {"msg":"repo synced","did":"did:plc:wwx…","records":2,"upserted":2,"deleted":0}
  {"msg":"sweep complete","status":"ok","reposSeen":1,"recordsUpserted":2,"reposFailed":0}
  ```

  `atproto_collection_recipe` then held both rows ("Pnpm Path Cake", "Verify Loop
  Stew") keyed by the local did. Throwaway PG removed afterward — no shared-DB
  pollution.

- **Typecheck:** `@buttery/atproto-dev-env`, `@buttery/atproto-cron-sync`, and
  `@buttery/web` all pass. ✅

## Known gaps / follow-ups

- **Interactive app login not exercised end-to-end.** The OAuth _surface_ is
  confirmed (spike) and the config edits compile, but a real browser login through
  the buttery app + a recipe publish wasn't driven, because (a) it's interactive
  and (b) the railway dev-DB tunnel was down this session (the app needs it for the
  OAuth session store). To confirm: bring the dev DB up, run `pnpm atproto:dev-env`,
  paste the env block into `services/web/.env`, `railway run --service buttery --
pnpm dev`, sign in as `chef.test` / `devpw-chef-000`, publish, then
  `pnpm --filter @buttery/atproto-dev-env records`.
- **`railway run` DATABASE_URL is a tunnel.** `railway run` injects
  `localhost:33628` (an ephemeral tunnel). When the dev servers are stopped the
  tunnel is down and any local process using that URL gets
  `ECONNREFUSED ::1/127.0.0.1:33628`. Start the dev DB before local cron runs
  against the shared DB.
- **`localhost` vs `127.0.0.1`.** dev-env binds `localhost`; buttery's loopback
  OAuth client requires the app redirect on `127.0.0.1`. These are different hosts
  (app vs PDS) so it's fine, but keep `BETTER_AUTH_URL=http://127.0.0.1:3000`.
- **Ephemeral did.** dev-env is in-memory; each restart mints a new did:plc, so
  re-login + re-seed after restarts. Helpers already resolve handle→did at runtime.
