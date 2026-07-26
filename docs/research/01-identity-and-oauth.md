# Identity & OAuth (bring-your-own account)

Verified 2026-07-25. Package versions read live from the npm registry.

---

## 1. Identity: DIDs, handles, DID documents

### DIDs are the only stable identifier

| Method                | Share | Resolution                                     | Notes                                                                                                                                                                             |
| --------------------- | ----- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `did:plc:...`         | ~98%  | `GET https://plc.directory/{did}`              | Supports key rotation without identity loss. Governance moving to an independent PLC Organization (announced ~Mar 2026). PLC gained WebSocket streaming for replicas in Jan 2026. |
| `did:web:example.com` | small | `GET https://example.com/.well-known/did.json` | Ties identity to DNS ownership.                                                                                                                                                   |

**Buttery's `users` table PK is `did text primary key`.** `handle` is a mutable denormalized column
with a `handle_resolved_at` timestamp, refreshed on login and periodically. Never join on handle.
Never put a handle in a URL you promise is stable.

### Handle resolution (two mechanisms, either may be used)

- DNS TXT at `_atproto.{handle}` → `did=did:plc:...`
- `GET https://{handle}/.well-known/atproto-did` → plaintext DID

`com.atproto.identity.resolveHandle` on any PDS does this for you. In TS, `@atproto/identity`
(`IdResolver`, `DidResolver`, `HandleResolver`) handles both directions with caching.

`handle.invalid` is a sentinel emitted when resolution fails — don't render it.

**Verification must be bidirectional.** The DID doc's `alsoKnownAs: ["at://alice.example.com"]` is a
_claim_; the handle must resolve back to that DID for it to be valid.

Cheap alternative to running your own resolver cache: `blue.microcosm.identity.resolveMiniDoc` on
[slingshot.microcosm.blue](https://slingshot.microcosm.blue/) does bidirectional handle↔DID
resolution as a free edge-cached HTTP call. (One person's servers — cache and degrade gracefully.)

### DID document → PDS discovery

Resolving a DID yields:

```jsonc
{
  "alsoKnownAs": ["at://alice.example.com"],
  "verificationMethod": [{ "id": "#atproto", ... }],   // repo signing key
  "service": [{
    "id": "#atproto_pds",
    "type": "AtprotoPersonalDataServer",
    "serviceEndpoint": "https://pds.example.com"        // ← where you write
  }]
}
```

`@atproto/oauth-client-node` does this internally on `authorize()` and on every `restore()`, so you
get PDS-migration handling largely free — but only at restore time.

### Identity lifecycle events and how to react

| Event       | Payload                    | Buttery's reaction                                                                                                                                             |
| ----------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#identity` | `did`, `time`, `handle?`   | Handle or DID doc _may_ have changed. Invalidate cached handle **and cached PDS endpoint**; re-resolve. Advisory/best-effort — never treat as source of truth. |
| `#account`  | `did`, `active`, `status?` | `status` ∈ `takendown \| suspended \| deactivated \| deleted`. Hide from public views, **retain rows**.                                                        |
| `#commit`   | record ops                 | Index create/update/delete.                                                                                                                                    |
| `#sync`     | state assertion            | Repo may have desynced; refetch. (Sync v1.1 addition.)                                                                                                         |

The old `#handle`, `#migration`, and `#tombstone` messages are **fully removed**.

**Account status policy for Buttery:**

- `deactivated` / `suspended` / `takendown` → hide from browse, keep the data. These reverse
  frequently (PDS migrations show up as deactivations). Show "account unavailable", not 404.
- `deleted` → stop serving immediately (return gone, not never-existed); defer permanent purge to a
  background job on your own retention policy.
- **PDS migration → do nothing.** DID is unchanged; that's the entire reason you key on DID. But note
  it _does_ invalidate the OAuth session (bound to the old authorization server) — handle it as a
  normal "session expired, sign in again" path.

---

## 2. OAuth in a Node/TypeScript server

### Package versions (npm, 2026-07-25)

| Package                      | Version   | Notes                                                                                                          |
| ---------------------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `@atproto/oauth-client-node` | **0.4.9** | ESM-only, `engines.node >= 22`                                                                                 |
| `@atproto/lex`               | **0.3.0** | **New** — unified codegen (`ts-lex`) + typed `Client`. The `@atproto/api` README now points new projects here. |
| `@atproto/api`               | 0.20.34   | Legacy-ish full Bluesky client                                                                                 |
| `@atproto/tap`               | 0.3.10    | TS client for Tap                                                                                              |
| `@atproto/identity`          | 0.5.6     |                                                                                                                |
| `@atproto/syntax`            | 0.7.2     | DID/handle/NSID/AT-URI parsers; tiny, always useful                                                            |
| `@atproto/jwk-jose`          | 0.2.4     | `JoseKey`                                                                                                      |

**Runtime constraint, confirmed from source:** `@atproto/oauth-client-node` imports
`createHash`/`randomBytes` from `node:crypto` and does DNS TXT lookups via `node:dns`. Pure ESM,
Node ≥ 22. **Node 22, not 24** — the statusphere tutorial warns 24 breaks on a `Request` bug.

- Cloudflare Workers: **no** (unsupported fetch options, `JoseKey` doesn't survive KV, no DNS).
- Deno: **broken** ("jwk private key export not implemented").
- Bun: untested. `[inferred]`

### Client metadata — the document that _is_ your identity

Buttery is a **confidential client** (server-side, holds keys). Confidential clients get **180-day
refresh tokens / ~2-year sessions**; public clients are capped at 2 weeks. This matters a lot for a
recipe app people use sporadically.

```jsonc
// served at https://buttery.app/client-metadata.json — this URL IS the client_id
{
  "client_id": "https://buttery.app/client-metadata.json",
  "client_name": "Buttery",
  "client_uri": "https://buttery.app",
  "redirect_uris": ["https://buttery.app/oauth/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "scope": "atproto repo:exchange.recipe.recipe repo:exchange.recipe.collection blob:image/*",
  "application_type": "web",
  "token_endpoint_auth_method": "private_key_jwt",
  "token_endpoint_auth_signing_alg": "ES256",
  "dpop_bound_access_tokens": true,
  "jwks_uri": "https://buttery.app/.well-known/jwks.json",
}
```

Hard requirements:

- `client_id` must be a fully-qualified **https** URL, **no port**, returning this JSON with 200.
  **The user's PDS fetches it server-to-server.** No Cloudflare Access, no basic auth, no bot
  challenge in front of it.
- Every `redirect_uri` must be declared here and share the `client_id` origin.
- **PKCE (S256), PAR, and DPoP are all mandatory.** DPoP nonces rotate ≤5 min. A hand-rolled `fetch`
  will fail — always go through `Agent`/`OAuthSession`/`Client`.

⚠️ **Changing your domain changes your client identity and invalidates every session, forcing
re-consent from every user.** Attach the custom domain before your first real user. Build the URL
from `RAILWAY_PUBLIC_DOMAIN`, which resolves to the custom domain once attached.

The SDK serves both docs for you:

```ts
// route handlers, NOT createServerFn — these are fetched by machines, not browsers
GET /client-metadata.json     → client.clientMetadata
GET /.well-known/jwks.json    → client.jwks
```

### Keys and rotation

```ts
keyset: await Promise.all([
  JoseKey.fromImportable(process.env.PRIVATE_KEY_1!, "key1"),
  JoseKey.fromImportable(process.env.PRIVATE_KEY_2!, "key2"),
  JoseKey.fromImportable(process.env.PRIVATE_KEY_3!, "key3"),
]);
```

The three-key example _is_ the rotation strategy: publish N public keys in JWKS, sign with the
first. To rotate, prepend a new key and drop the oldest after authorization servers re-fetch your
JWKS. ES256/P-256 PKCS#8 PEM in Railway env vars, matching `token_endpoint_auth_signing_alg`.

### The two required stores — back them with Postgres

```sql
create table auth_state   (key text primary key, state jsonb not null,
                           created_at timestamptz not null default now());
create table auth_session (did text primary key, session jsonb not null,
                           updated_at timestamptz not null default now());
```

- **State store** — in-flight authorization requests: PKCE verifier, DPoP private key, `state`, the
  resolved authorization server. Keyed by an opaque request key. Short-lived; cron
  `delete from auth_state where created_at < now() - interval '1 hour'`.
- **Session store** — the durable credential: access token, refresh token, session DPoP key, token
  endpoint. **Keyed by `sub` = the user's DID.** Losing this means every user loses write access.

Both must be **shared across instances** — a login can start on replica A and the callback land on
replica B. The in-memory `Map` stores in some tutorials are dev-only.

Statusphere (the canonical reference app) uses exactly this shape, and it's on **Kysely** — its
store implementations are near-copy-paste for Buttery.

```ts
class StateStore implements NodeSavedStateStore {
  constructor(private db: Kysely<DB>) {}
  async get(key: string) {
    const r = await this.db.selectFrom("auth_state").selectAll().where("key", "=", key).executeTakeFirst();
    return r ? (r.state as NodeSavedState) : undefined;
  }
  async set(key: string, state: NodeSavedState) {
    await this.db
      .insertInto("auth_state")
      .values({ key, state })
      .onConflict((oc) => oc.column("key").doUpdateSet({ state }))
      .execute();
  }
  async del(key: string) {
    await this.db.deleteFrom("auth_state").where("key", "=", key).execute();
  }
}
// SessionStore is identical, keyed on `did` (the `sub` argument).
```

### `requestLock` — mandatory the moment you have 2 replicas

```ts
const requestLock: RuntimeLock = async (key, fn) => {
  /* distributed lock */
};
```

Without it, two concurrent requests for the same user can both attempt a token refresh. The first
rotates the refresh token; the second fails; **the session is destroyed.** There is no default.

Single Railway replica → an in-process async mutex is fine. Multiple replicas → you already have
Postgres, so use an advisory lock rather than adding Redis:

```ts
const requestLock: RuntimeLock = async (key, fn) => {
  const k = hashToBigInt(key);
  await sql`select pg_advisory_lock(${k})`.execute(db);
  try {
    return await fn();
  } finally {
    await sql`select pg_advisory_unlock(${k})`.execute(db);
  }
};
```

(Rocksky uses Redis+Redlock for this; Leaflet uses Redlock. Advisory locks are the free option.)

### The flow

```ts
// 1. login
const url = await client.authorize(handleOrDid, { state: crypto.randomUUID() }); // → 302

// 2. callback (a real route, not a server function)
const { session, state } = await client.callback(new URLSearchParams(qs));
// set httpOnly, secure, sameSite:'lax' cookie containing ONLY the DID

// 3. every subsequent request
const oauthSession = await client.restore(did);
```

`restore()` transparently refreshes and re-persists. Listen for termination:

```ts
client.addEventListener("deleted", (e) => {
  const { sub, cause } = e.detail;
  // TokenRefreshError → refresh token dead/expired
  // TokenRevokedError → user revoked, or signOut() called
  markNeedsReauth(sub);
});
```

On refresh failure the SDK deletes the session from your store. **Your Postgres index and private
household data must survive the session being gone** — degrade to "reconnect your account", never
lose data.

---

## 3. Scopes

Granular permissions shipped on `bsky.social` in Aug 2025; permission sets in Jan 2026.
`transition:generic` is legacy. Statusphere now requests `atproto repo:xyz.statusphere.status`.

**Verified from [atproto.com/guides/scopes](https://atproto.com/guides/scopes):
"There are currently no plans to deprecate either the transition scopes or the use of App
Passwords."** Use OAuth anyway — app passwords hand your server a long-lived credential.

Grammar: `resource[:positional][?param=value]`. The bare `atproto` scope is **always required**.

| Resource    | Examples                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| `repo:`     | `repo:exchange.recipe.recipe` (create+update+delete), `repo:exchange.recipe.recipe?action=create`, `repo:*`  |
| `blob:`     | `blob:image/*`, `blob:*/*`, `blob?accept=image/jpeg&maxSize=1000000` (glob MIME allowed here)                |
| `rpc:`      | `rpc:{lxm}?aud={did}#{fragment}` — either `lxm` or `aud` may be `*`, not both                                |
| `account:`  | `account:email` (read), `account:repo?action=manage`                                                         |
| `identity:` | `identity:handle`, `identity:*` — Buttery needs neither                                                      |
| `include:`  | permission sets, e.g. `include:app.bsky.authFull?aud=did:web:api.bsky.app%23bsky_appview` (note `#` → `%23`) |

**Recommended for Buttery:**

```
atproto repo:exchange.recipe.recipe repo:exchange.recipe.collection blob:image/*
```

Add `repo:exchange.recipe.profile` if you write profiles, `account:email` only if you need email.

### Scope gotchas — these will cost you a day each

1. **The client-metadata `scope` is the maximum you will ever request.** The PDS validates each
   request against it. Widening later requires re-publishing metadata **and re-consent from every
   user**. Request your full intended set at first login.
2. **Progressive scope upgrade is rough.** `prompt: 'consent'` reportedly doesn't reliably force a
   re-grant; the working workaround is `session.signOut()` then re-`authorize()` with the wider
   scope. Design to avoid needing this.
3. **`session.scope` returns `undefined`** — use `await session.getTokenInfo()` to read granted scopes.
4. There is no canonical `atproto.com/specs/permissions` page (404s as of 2026-07-25). The grammar
   above is assembled from the scopes/permission-sets guides, discussion #4118, proposal 0011, and
   the Go SDK docs. **Verify your exact scope string against a live `bsky.social` flow before
   shipping.** Open question: whether `blob:image/*` alone suffices for `uploadBlob` or whether you
   also need `rpc:com.atproto.repo.uploadBlob`.

---

## 4. Writing on behalf of users

The modern path uses `@atproto/lex`, not `agent.com.atproto.repo.*`. Statusphere's write:

```ts
import { Client, l } from "@atproto/lex";
import * as exchange from "@/lib/lexicons/exchange";

const lexClient = new Client(oauthSession);
const res = await lexClient.create(exchange.recipe.recipe, {
  name,
  text,
  ingredients,
  instructions,
  createdAt: l.currentDatetimeString(),
  updatedAt: l.currentDatetimeString(),
});
```

Codegen: `ts-lex build --importExt="" --out=./lib/lexicons --override`, output **generated at build,
not committed**. `ts-lex install <nsid>` pulls a lexicon from the network by NSID.

The classic path still works (`agent.com.atproto.repo.createRecord`) if you prefer `@atproto/api`.

**The request goes to the user's PDS**, resolved from their DID doc — not to `bsky.social`
unconditionally.

### Rate limits

- **Repo writes: 5,000 points/hour, 35,000/day, per account.** CREATE=3, UPDATE=2, DELETE=1.
  ≈1,666 creates/hour per user. Irrelevant for normal use; relevant for a **bulk recipe importer**
  (`applyWrites` batching still costs 3 points per created record).
- **Global: 3,000 requests / 5 min, rate-limited by IP.** On Railway your whole app shares an egress
  IP, so all users' writes to a given PDS share one bucket. **This is the limit you'll actually hit.**
  Queue per-PDS and honor `RateLimit-Remaining` / `RateLimit-Reset`.
- Blob upload hard max 50 MB — but the recipe lexicon caps images at **1 MB**. Compress client-side.

### The user's PDS is a third party that will go down

This is the structural difference from a normal app: **your write path depends on someone else's
uptime**, and self-hosted PDSes are often on home connections.

- **Never write to the PDS synchronously inside a request that blocks a render.**
- Use an **outbox table**: write locally with `status='pending'`, return immediately, a worker
  attempts the PDS write with exponential backoff and reconciles `uri`/`cid` back into the row.
  (Frontpage formalizes this as `pending → live` with soft deletes.)
- 502/503/504/timeout → retryable. 400 `InvalidRequest` / lexicon validation → permanent, don't loop.
  401 `InvalidToken` → `restore()` and retry once, then require re-auth.
- Aggressive HTTP timeout (~10 s).
- **PDS availability must never affect _reading_ recipes in Buttery.** Your Postgres is the read path.

---

## 5. TanStack Start specifics

TanStack Start is `@tanstack/react-start@1.168.x`, still formally **RC**. **Vinxi is gone** — it's a
plain Vite plugin now (`vite >= 7`), with Rsbuild as a first-class alternative since June 2026.
**Nitro is opt-in, not built in**; the internal server layer is UnJS `srvx`. Railway is a documented
official hosting target (`nitro/vite` → `.output/server/index.mjs` under Node).

**There are zero public examples of atproto OAuth in TanStack Start.** You'd be first. The nearest
transferable references are Statusphere (Next 16) and `mozzius/statusphere-react` (Vite SPA +
Express). Pitfalls specific to this combination:

1. **The OAuth callback must be a server _route_, not a `createServerFn`.** Server functions compile
   to framework-owned internal RPC endpoints; the authorization server does a plain browser GET to a
   registered `redirect_uri`. Use file-based server routes
   (`createFileRoute('/oauth/callback')({ server: { handlers: { GET } } })`). Same for
   `/client-metadata.json` and `/.well-known/jwks.json`.
2. **Vite `ssr.external` is your `serverExternalPackages`.** Keep `@atproto/oauth-client-node`,
   `jose`, `undici`, `pg`, `kysely` out of the SSR bundle. Counterpart: `ssr.noExternal` is the
   documented fix for AsyncLocalStorage context loss from externalization (router#4409), and Start
   has a history of ignoring `noExternal` (router#2663) — verify empirically.
3. **Sessions:** `useSession()` from `@tanstack/react-start/server` is a sealed-cookie session.
   `getCookie`/`setCookie`/`deleteCookie` exist but are undocumented. Known bug: **a server function
   cannot read a cookie it just set in the same request** (router#5615). Put only the DID in the
   cookie; tokens live in Postgres.
4. **Module-level OAuth client + Vite HMR = duplicate clients.** Stash on `globalThis`. Make
   construction lazy and memoized as a `Promise<NodeOAuthClient>` — `JoseKey.fromImportable()` is
   async, and a lazily-constructed-on-first-login client breaks `restore()` after a redeploy.
5. **Loopback dev asymmetry:** `client_id` origin must be exactly `http://localhost` (no IP, no port,
   only `scope` and `redirect_uri` query params) — but the **default `redirect_uri` is
   `http://127.0.0.1/`**. Run dev on `http://127.0.0.1:3000` so the callback lands on the same origin
   as your cookie. Helper: `buildAtprotoLoopbackClientMetadata({ scope, redirect_uris })`. Loopback
   clients are **public** clients with no keyset — dev and prod configs differ structurally, and dev
   sessions expire in 2 weeks.
6. A tunnel (ngrok/cloudflared) is only needed to exercise the _confidential_-client path locally;
   ordinary loopback dev doesn't need one. If you do tunnel, `client_id`, `redirect_uris`, and
   `jwks_uri` must all agree on the tunnel URL.
7. **Supply chain:** TanStack had an npm compromise in May 2026. Pin exact versions, use `npm ci`.

---

## Sources

[Identity guide](https://atproto.com/guides/identity) ·
[OAuth spec](https://atproto.com/specs/oauth) ·
[Sync spec](https://atproto.com/specs/sync) ·
[Account spec](https://atproto.com/specs/account) ·
[Scopes guide](https://atproto.com/guides/scopes) ·
[Permission sets](https://atproto.com/guides/permission-sets) ·
[OAuth improvements](https://atproto.com/blog/oauth-improvements) ·
[oauth-client-node README](https://github.com/bluesky-social/atproto/blob/main/packages/oauth/oauth-client-node/README.md) ·
[Statusphere tutorial](https://atproto.com/guides/statusphere-tutorial) ·
[statusphere-example-app](https://github.com/bluesky-social/statusphere-example-app) ·
[Rate limits](https://docs.bsky.app/docs/advanced-guides/rate-limits) ·
[Progress on auth scopes #4118](https://github.com/bluesky-social/atproto/discussions/4118) ·
[Proposal 0011](https://github.com/bluesky-social/proposals/blob/main/0011-auth-scopes/README.md) ·
[Account migration](https://github.com/bluesky-social/pds/blob/main/ACCOUNT_MIGRATION.md) ·
[slingshot](https://slingshot.microcosm.blue/)
