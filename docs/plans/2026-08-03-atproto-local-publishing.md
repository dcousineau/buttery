# Local ATProto publishing (dev-only, real network untouched)

> Created 2026-08-03
> Goal: in **local dev mode only**, publish `exchange.recipe.recipe` records to a
> local PDS so nothing ever reaches the real atmosphere (no plc.directory, no
> bsky.social, no relay). Prod behavior unchanged.

## Decisions (locked with the requester)

- **Stack:** `@atproto/dev-env` (Bluesky's own TS harness). Booted as a standalone
  local process exposing a PDS + a **local PLC directory** — the local PLC is what
  keeps DID resolution off the real network.
- **Scope: publish-only for the _app_.** The login → DID/PLC resolve → PDS
  **write** chain goes local. The app's in-page **read-back** (recipe render via
  APPVIEW `public.api.bsky.app`) stays pointed at prod and is out of scope — a
  human won't see the local recipe render in the app.
- **Read access for verification (in scope).** Two consumers _do_ read the local
  PDS, so the publish loop can be confirmed end-to-end:
  1. **Agents (Claude Code, incl. this one).** Must be able to read the local PDS
     to run a test → publish → **read-back** → evaluate loop and confirm a publish
     actually landed. Requires stable, documented, unauthenticated read access +
     a helper (task 5).
  2. **`atproto-cron-sync` in local-dev mode.** Points at the local PDS/PLC so it
     ingests the local record into the (railway dev) Postgres — giving a real
     end-to-end path an agent can also verify via the DB (task 6).
- **Auth reality:** buttery is **OAuth (DPoP) only** — there is no app-password
  write path (`recipe-writes.ts` uses a restored `OAuthSession`). So "publish-only"
  still requires the full OAuth login to complete against the local network.
- **Railway:** dev-env runs as a separate local Node process, **not** deployed to
  Railway. buttery web still runs via `railway run --service buttery -- pnpm dev`
  for its real dev env vars; the local ATProto overrides layer on top via
  `services/web/.env` (vite auto-loads it; railway-injected vars still win where
  they overlap, and these ATPROTO_* vars don't overlap).

## Why so few app changes

The write path is PDS-agnostic already: `getUserRecipeClient(did)` restores the
stored OAuth session and the `OAuthSession` carries whatever PDS the DID doc named
(`services/web/src/lib/atproto/recipe-writes.ts:23-26,44`). If we log in as a
**local** account whose did:plc (registered in the local PLC) points at the local
PDS, every write lands locally with **zero changes to `recipe-writes.ts`**.

The only real-network leaks in the _publish_ chain are in OAuth client config:

| Leak                                | Location                                                                                         | Fix                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Handle resolver hardcoded           | `oauth-node.ts:8` (`HANDLE_RESOLVER = "https://bsky.social"`), used at `:102`                    | env-configurable, default unchanged                    |
| DID resolution → real plc.directory | `oauth-node.ts:100` `NodeOAuthClient` never passes `plcDirectoryUrl` (defaults to plc.directory) | add `plcDirectoryUrl` from env                         |
| Publish gate blocks in dev          | `posthog-server.ts:91` fail-closed                                                               | already overridable via `ATPROTO_PUBLISH_ENABLED=true` |

`allowHttp: isLoopback` is already `true` in dev (`oauth-node.ts:103`), so the
plaintext-HTTP local PDS is accepted with no change.

## Architecture

```
┌─ local Node process (NOT on Railway) ────────────┐
│  @atproto/dev-env TestNetwork (fixed ports)      │
│   ├─ PLC  (local DID registry)  :2582            │
│   ├─ PDS  (OAuth authz + repo)  :2583            │
│   └─ seeded user: <you>.test  (did:plc:… local)  │
└──────────────────────────────────────────────────┘
        ▲ OAuth authorize/PAR/DPoP + createRecord
        │ handleResolver + plcDirectoryUrl → local
┌─ buttery web (railway run … pnpm dev, :3000) ────┐
│  reads ATPROTO_* from services/web/.env           │
└──────────────────────────────────────────────────┘
```

## Tasks

### 0. SPIKE (do first — this de-risks everything): confirm dev-env serves OAuth

buttery cannot log in with an app password. The whole plan hinges on the dev-env
PDS serving the OAuth **authorize + consent** endpoints (PAR → consent HTML →
code → DPoP token exchange).

- Boot a throwaway `@atproto/dev-env` `TestNetwork`, `mkuser("alice.test")`.
- Point a minimal `NodeOAuthClient` (loopback client, `allowHttp: true`,
  `handleResolver` + `plcDirectoryUrl` = the dev-env urls) at `alice.test` and run
  `authorize()` → follow the redirect → `callback()`.
- **Pass:** you get an `OAuthSession` and can `com.atproto.repo.createRecord`.
- **Fail / no consent UI:** fall back (see Risks) to the bare
  `ghcr.io/bluesky-social/pds:0.4` container (definitely serves OAuth) + a local
  PLC; revisit stack choice with the requester before continuing.
- Log the dev-env version tested and the exact urls/ports it binds.

### 1. dev-env runner (`services/atproto-dev-env/`)

New tiny package (mirror the Node-native-TS, minimal-dep style of
`services/atproto-cron-sync/`; see [[buttery-cron-node-ts-imports]]).

- `package.json`: dep `@atproto/dev-env`; script `start: "node src/main.ts"`.
- `src/main.ts`:
  - Boot `TestNetwork.create(...)` with **fixed** PLC + PDS ports (dev-env
    randomizes by default — pin them so `.env` can reference stable urls).
  - Create/ensure a seed user (`<handle>.test`) via `mkuser`; make handle + port
    overridable by env for flexibility.
  - On boot, print a copy-paste block: PDS url, PLC url, handle, did, and the
    values to drop into `services/web/.env` (see task 3).
  - Keep the process alive; clean shutdown on SIGINT/SIGTERM.
  - NOTE in README: state is in-memory/ephemeral — every restart mints a **new**
    did:plc, so you re-login in buttery after each restart (cheap).
- `README.md`: how to run, ports, the ephemerality caveat, and the isolation
  guarantee (no traffic to plc.directory / bsky.social / relay).
- Do **not** add it to `.railway/railway.ts` — local-only by design.

### 2. buttery OAuth config → env-driven (`services/web/src/lib/atproto/oauth-node.ts`)

Keep prod defaults identical; only add env overrides.

- Replace the `HANDLE_RESOLVER` const (`:8`) with
  `process.env.ATPROTO_HANDLE_RESOLVER ?? "https://bsky.social"`.
- In `getAtprotoOAuthClient()` (`:100`), pass `plcDirectoryUrl` **only when set**:
  `...(process.env.ATPROTO_PLC_URL ? { plcDirectoryUrl: process.env.ATPROTO_PLC_URL } : {})`.
  Unset → `@atproto/oauth-client-node` keeps its plc.directory default (prod
  unchanged). Verify the option name against the installed
  `@atproto/oauth-client-node` version before committing.
- No change to `recipe-writes.ts`, the gate module, or the better-auth plugin.

### 3. Local env wiring (`services/web/.env` + `.env.example`)

Add to `.env.example` (documented, commented "local dev only"):

```
# --- Local ATProto dev publishing (dev only; leave UNSET in prod) ---
# Point OAuth handle + DID resolution at a local @atproto/dev-env network so
# publishes never reach the real atmosphere. Values are printed by
# `services/atproto-dev-env` on boot.
# ATPROTO_HANDLE_RESOLVER=http://127.0.0.1:2583
# ATPROTO_PLC_URL=http://127.0.0.1:2582
# ATPROTO_PUBLISH_ENABLED=true
```

- `BETTER_AUTH_URL` stays `http://127.0.0.1:3000` (loopback OAuth client already
  requires 127.0.0.1, not localhost — `oauth-node.ts:14-22`). Use `127.0.0.1` for
  the dev-env urls too, to match the loopback validation caveat from the research.
- Setting `ATPROTO_PUBLISH_ENABLED=true` flips the fail-closed gate
  (`posthog-server.ts:91-104`) without needing PostHog locally.

### 4. DX glue + docs

- Root/workspace script, e.g. `pnpm atproto:dev-env`, to run task 1's service.
- Short section in `docs/ECOSYSTEM.md` (or the web README): the two-terminal flow —
  (1) `pnpm atproto:dev-env`, copy its env block into `services/web/.env`;
  (2) `railway run --service buttery -- pnpm dev`; log in with `<handle>.test`,
  publish, verify.

### 5. Agent read access + verify helper (the test-eval-loop affordance)

So an agent can confirm a publish landed without a human in the loop:

- **Stable, predictable endpoint.** dev-env PDS on a **fixed** port (task 1) with
  unauthenticated read xrpc (`com.atproto.repo.listRecords` / `getRecord` need no
  auth). The did:plc changes each dev-env restart, so an agent must resolve the
  seed handle → did first, not assume a did.
- **Helper command** in `services/atproto-dev-env`, e.g. `pnpm atproto:dev-env:records`
  (or `node src/records.ts`), that:
  - resolves `<handle>.test` → did via the local PLC/PDS,
  - lists `exchange.recipe.recipe` records for that did,
  - prints uri/cid/rkey + the record JSON.
    Deterministic, greppable output so an agent can assert on it.
- **Discoverability.** Document the loop in `CLAUDE.md` (or a
  `services/atproto-dev-env/CLAUDE.md`): "to verify an ATProto publish locally, run
  `<helper>` and check the record is present." Agents read CLAUDE.md automatically;
  this is how a future agent finds the affordance. Consider adding the helper
  command to the project's Bash allowlist so agents run it without a prompt.
- Keep it **read-only** — the helper never writes/deletes on the PDS.

### 6. cron-sync local-dev mode → hit the dev server (`services/atproto-cron-sync/`)

Currently the cron leaks to real infra: `identity.ts:30` hardcodes
`https://plc.directory`, and `config.ts:25` defaults the relay to
`relay1.us-east.bsky.network`. Make both env-driven so a local sweep reads the
dev PDS and writes local records into the (railway dev) Postgres.

- `identity.ts:30`: replace the `plc.directory` literal with
  `process.env.ATPROTO_PLC_URL ?? "https://plc.directory"` (reuse the **same** var
  name as the web app for one knob). did:web branch unaffected.
- Relay enumeration: `enumerateDids` (`relay.ts:20`) calls
  `com.atproto.sync.listReposByCollection` on the relay. **dev-env may not ship a
  relay** (open question below). Two supported local modes:
  - **If dev-env exposes a relay:** set `RELAY_URL` to it (already configurable,
    `config.ts:44`).
  - **If not (likely):** skip enumeration by setting `SYNC_ONLY_DID=<local did>`
    (already supported, `config.ts:48`) — the sweep then resolves that DID via the
    local PLC and reads the local PDS directly, no relay needed. Document this as
    the default local recipe.
- Local run: `railway run --service buttery -- env ATPROTO_PLC_URL=… SYNC_ONLY_DID=… node services/atproto-cron-sync/src/main.ts --once`
  (railway for `DATABASE_URL`; ATPROTO_PLC_URL + SYNC_ONLY_DID point it local).
- Prod unchanged: both vars unset → plc.directory + real relay, exactly as today.
- After a successful publish + local sweep, the local recipe row exists in the dev
  Postgres — an agent can verify via `mcp__postgres__execute_sql` too.

## Verification / acceptance

1. dev-env up; buttery up with the three ATPROTO_* vars set.
2. Log in via OAuth using `<handle>.test` → completes, no request to
   `bsky.social` / `plc.directory` (confirm by watching dev-env has traffic and,
   ideally, that outbound to those hosts is absent — e.g. Little Snitch / a proxy,
   or just trust the local-only resolver config).
3. Publish a recipe in-app → `status` is success, not `publish_disabled`.
4. Confirm the record exists in the **local** PDS via the task-5 helper (the
   agent path) — or `curl
"http://127.0.0.1:2583/xrpc/com.atproto.repo.listRecords?repo=<did>&collection=exchange.recipe.recipe"`,
   or point `pdsls.dev` at the local PDS.
5. Run the local cron sweep (task 6) → the recipe row lands in the dev Postgres;
   confirm via `mcp__postgres__execute_sql`. This closes the full agent-verifiable
   loop: publish → local PDS → cron → DB.
6. Sanity: with all ATPROTO_* vars + `SYNC_ONLY_DID` **unset**, prod path is
   byte-for-byte unchanged (gate blocks, resolver = bsky.social, no plcDirectoryUrl,
   cron → plc.directory + real relay).

## Risks / open questions

- **[Highest] dev-env OAuth consent** — see task 0. If dev-env doesn't serve the
  authorize/consent UI, the fallback is bare `pds:0.4` container + a local PLC
  (heavier; the research's `atproto-devnet` Compose stack bundles exactly PDS +
  local PLC + Jetstream and is the natural fallback). Resolve before task 1.
- **`plcDirectoryUrl` option name/shape** — verify against the pinned
  `@atproto/oauth-client-node`; the identity resolver may name it differently.
- **Shared dev Postgres pollution** — local test DIDs write rows to
  `atproto_oauth_session` / user tables in the railway dev DB. Harmless (keyed by
  DID); note a cleanup query. See [[buttery-local-dev-db]].
- **dev-env relay availability** — task 6. If `@atproto/dev-env` `TestNetwork`
  doesn't expose a relay/firehose, the cron local mode uses `SYNC_ONLY_DID` +
  local PLC (no enumeration) — sufficient for the verify loop. Confirm in task 0.
- **Ephemeral did:plc** — dev-env is in-memory; every restart mints a new did. The
  task-5 helper and task-6 `SYNC_ONLY_DID` must resolve the seed handle → did at
  runtime, never hardcode a did.
- **Handle resolution transport** — dev-env `.test` handles resolve via the PDS/
  appview xrpc, not DNS. Ensure `ATPROTO_HANDLE_RESOLVER` points at a service that
  serves `com.atproto.identity.resolveHandle` for the seeded handle.
- **Read-back not local** (accepted) — published recipes won't render in-app; the
  APPVIEW/relay read path is untouched. Making reads local is a separate,
  larger effort (needs a local appview or direct-PDS read routing).

## Results

Per buttery convention ([[buttery-plan-results-convention]]), the implementer must
log outcomes to `docs/plans/results/2026-08-03-atproto-local-publishing-results.md`
— especially the task-0 spike result (does dev-env OAuth work?) and the final
verified isolation check.
