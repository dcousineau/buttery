# Annotated Reference Index

Verified 2026-07-25. Ordered by how often you'll actually open them.

---

## Tier 1 — keep these open while building

| Link                                                                                 | Why                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [statusphere-example-app](https://github.com/bluesky-social/statusphere-example-app) | **The closest template to Buttery.** `main` is Next 16.2 + React 19 + `@atproto/lex` + `@atproto/tap` + **Kysely 0.29** + better-sqlite3. Swap Next→TanStack Start and SQLite→Postgres and you have Buttery's skeleton. Its OAuth store implementations are near-copy-paste. The old Express + in-process-firehose version is on branch [`statusphere-og`](https://github.com/bluesky-social/statusphere-example-app/tree/statusphere-og). |
| [Statusphere tutorial](https://atproto.com/guides/statusphere-tutorial)              | The current walkthrough. ⚠️ [atproto.com/guides/applications](https://atproto.com/guides/applications) is **stale** — still describes the Express era.                                                                                                                                                                                                                                                                                     |
| [OAuth spec](https://atproto.com/specs/oauth)                                        | `client_id` rules, PKCE/PAR/DPoP, loopback client rules. The `client_id`-is-a-URL constraint is the one that shapes your deploy.                                                                                                                                                                                                                                                                                                           |
| [recipe.exchange/lexicons](https://recipe.exchange/lexicons/)                        | The four `exchange.recipe.*` schemas. Pin and diff in CI.                                                                                                                                                                                                                                                                                                                                                                                  |
| [Rate limits](https://docs.bsky.app/docs/advanced-guides/rate-limits)                | Write points, the 3,000/5min per-IP limit that will actually bite you.                                                                                                                                                                                                                                                                                                                                                                     |
| [Lexicon spec](https://atproto.com/specs/lexicon)                                    | Especially the **evolution rules** section.                                                                                                                                                                                                                                                                                                                                                                                                |
| [Tap README](https://github.com/bluesky-social/indigo/blob/main/cmd/tap/README.md)   | Every `TAP_*` env var, admin API, event shapes.                                                                                                                                                                                                                                                                                                                                                                                            |

## Tier 2 — specs you'll consult

- [Identity guide](https://atproto.com/guides/identity) — DIDs, handles, resolution
- [Repository spec](https://atproto.com/specs/repository) — MST, commits, size limits
- [Record key spec](https://atproto.com/specs/record-key) — TID vs literal vs nsid
- [Sync spec](https://atproto.com/specs/sync) — firehose messages, cursors, `#sync`
- [Account spec](https://atproto.com/specs/account) — lifecycle states
- [NSID spec](https://atproto.com/specs/nsid) — naming rules for your own namespace
- [Data validation guide](https://atproto.com/guides/data-validation) — what to do with invalid records
- [Publishing lexicons](https://atproto.com/guides/publishing-lexicons) — DNS `_lexicon` + `com.atproto.lexicon.schema`
- [Scopes guide](https://atproto.com/guides/scopes) / [Permission sets](https://atproto.com/guides/permission-sets)
- Canonical lexicon JSON: [`bluesky-social/atproto/lexicons`](https://github.com/bluesky-social/atproto/tree/main/lexicons)

## Tier 3 — blog posts that changed the architecture

| Post                                                                                                       | Date         | Why it matters                               |
| ---------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------- |
| [Introducing Tap](https://atproto.com/blog/introducing-tap)                                                | 2025-12-12   | Obsoletes hand-rolled firehose consumers     |
| [Relay updates / sync v1.1](https://atproto.com/blog/relay-updates-sync-v1-1)                              |              | Relays non-archival, `listReposByCollection` |
| [Relay rollout](https://atproto.com/blog/relay-rollout)                                                    | 2026-01-27   | Why `seq` cursors aren't portable            |
| [Introducing Hubble](https://atproto.com/blog/introducing-hubble-a-public-mirror-for-the-whole-atmosphere) | 2026-03-20   | Public whole-network mirror                  |
| [OAuth improvements](https://atproto.com/blog/oauth-improvements)                                          |              | Confidential clients → 180-day refresh       |
| [Spring 2026 roadmap](https://atproto.com/blog/2026-spring-roadmap)                                        |              | Permissioned data status                     |
| [Permissioned Data Diaries 1–7](https://dholms.leaflet.pub/)                                               | → 2026-07-17 | The private-data future                      |

---

## Reference applications — what to steal from each

| App                           | Repo                                                                                                | Stack                                                                                        | Steal                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Statusphere**               | [bluesky-social/statusphere-example-app](https://github.com/bluesky-social/statusphere-example-app) | Next 16, React 19, **Kysely**, `@atproto/lex`, `@atproto/tap`, SQLite                        | Everything. OAuth stores, `ts-lex` build step, Tap webhook route.                                                                                                                                                                                        |
| **Bookhive**                  | [nperez0111/bookhive](https://github.com/nperez0111/bookhive)                                       | Bun, Hono, React 19, `@atcute/oauth-node-client`, Kysely, SQLite                             | **The "hive" split** — canonical shared catalog in the app DB, PDS record carries a pointer + the user's own opinion. Directly applicable to your ingredient-parsing problem. Also multi-endpoint Jetstream rotation and per-DID `listRecords` backfill. |
| **Grain**                     | [grainsocial/grain](https://github.com/grainsocial/grain)                                           | SvelteKit + **hatk**, SQLite, single Railway service                                         | **Underscore-prefixed table convention** for AppView-local data (`_mutes`, `_oauth_*`, `_cursor`). Also a working single-service Railway atproto app.                                                                                                    |
| **Frontpage**                 | [likeandscribe/frontpage](https://github.com/likeandscribe/frontpage)                               | Next 16, Drizzle, Turso, hand-rolled OAuth on `oauth4webapi`                                 | **`pending → live` optimistic write status + soft deletes.** Also "Drainpipe" — a Rust Jetstream→webhook shim, i.e. they invented Tap's webhook mode before Tap existed.                                                                                 |
| **Leaflet**                   | [tangled.org/leaflet.pub/leaflet](https://tangled.org/leaflet.pub/leaflet)                          | Next 16, Replicache, Yjs, **Supabase Postgres** (EAV triple store), `@atproto/sync`, Redlock | The only major TS app on Postgres. Redlock `requestLock`. Collaborative editing over atproto.                                                                                                                                                            |
| **Tangled**                   | [tangled.org/tangled.org/core](https://tangled.org/tangled.org/core)                                | Go, htmx, SQLite                                                                             | **The cleanest public/private split in the ecosystem** — public records for identity/social, "knots" own ACLs, appview is "a glorified edge index."                                                                                                      |
| **Rocksky**                   | [tangled.org/rocksky.app/rocksky](https://tangled.org/rocksky.app/rocksky)                          | Hono/Bun + Rust, **Postgres** + Typesense + NATS                                             | `@atproto/oauth-client-node` + **Redis/Redlock `requestLock`** in production. Dedicated Rust Jetstream service with multi-endpoint dedupe.                                                                                                               |
| **Smoke Signal**              | [tangled.org/smokesignal.events/smokesignal](https://tangled.org/smokesignal.events/smokesignal)    | Rust, axum, HTMX                                                                             | Uses **Tap**. ["Source-based hydration"](https://blog.smokesignal.events/posts/3lvehxge7oo2a-atprotocol-record-hydration-building-privacy-aware-views) — coarse public record + authenticated call for the private remainder. Was on Railway.            |
| **Teal.fm**                   | [tangled.org/teal.fm/teal](https://tangled.org/teal.fm/teal)                                        | Rust (rewritten from TS), Postgres                                                           | `com.atproto.repo.importRepo` trigger-record pattern for CAR backfill.                                                                                                                                                                                   |
| **Germ**                      | [germnetwork.com](https://www.germnetwork.com/blog/integrating-germ-atproto)                        | MLS E2EE                                                                                     | The only real E2EE integration. One public keypackage record; everything else off-repo.                                                                                                                                                                  |
| **mozzius/statusphere-react** | [github](https://github.com/mozzius/statusphere-react)                                              | Vite SPA + Express, SQLite on a Railway volume                                               | **Single-service Railway deployment**, the closest thing to a TanStack-shaped reference.                                                                                                                                                                 |

**Closed source, but informative by their absence:** Popsky→Popfeed (public client, `transition:generic`),
Skylight (mints no lexicons — pure `app.bsky.*` client), recipe.exchange itself (app passwords, no OAuth).

⚠️ **Naming trap:** _Spark_ ([sprk.so](https://sprk.so), [server](https://github.com/sprksocial/server)) is an
unrelated short-form-video startup (Hono/Deno/MongoDB). _Spacedust_ is microcosm. Neither is a mary-ext project.

---

## Packages

### Official (`@atproto/*`, versions 2026-07-25)

| Package                           | Ver            | Use it?                                                                   |
| --------------------------------- | -------------- | ------------------------------------------------------------------------- |
| `@atproto/lex`                    | 0.3.0          | **Yes** — codegen (`ts-lex`) + typed `Client`. The going-forward surface. |
| `@atproto/oauth-client-node`      | 0.4.9          | **Yes.** ESM-only, Node ≥22.                                              |
| `@atproto/tap`                    | 0.3.10         | **Yes**, at stage 2. `SimpleIndexer` / `LexIndexer` / `parseTapEvent`.    |
| `@atproto/syntax`                 | 0.7.2          | **Yes.** Tiny; DID/handle/NSID/AT-URI parsers.                            |
| `@atproto/jwk-jose`               | 0.2.4          | **Yes.** `JoseKey`.                                                       |
| `@atproto/identity`               | 0.5.6          | Maybe — or use Slingshot's `resolveMiniDoc`.                              |
| `@atproto/api`                    | 0.20.34        | Only if you need the Bluesky lexicon surface.                             |
| `@atproto/lexicon` / `lex-cli`    | 0.7.7 / 0.10.6 | Legacy codegen path.                                                      |
| `@atproto/sync`                   | 0.3.13         | Lower-level firehose. Skip if using Tap.                                  |
| `@atproto/repo`, `crypto`, `xrpc` |                | Only for repo parsing / custom transport.                                 |
| `@atproto/xrpc-server`            | 0.11.11        | Only if Buttery exposes its own XRPC API.                                 |
| `@atproto/pds`                    | 0.5.21         | You're not running a PDS.                                                 |

**Breaking-change notes:** v0.20.0 of `@atproto/api` → min **Node 22**, **pure ESM**, TS 6.0. v0.14.0
changed codegen output (`isX` now discriminates `$type`; use `asPredicate(NS.validateRecord)`).
v0.17.4 added `.Main` alongside legacy `.Record`. `AtpAgent` is legacy; `Agent` + a session manager is
current.

⚠️ **The reference app lags npm.** Statusphere `main` pins `oauth-client-node ^0.4.8` / `tap ^0.3.8`
while latest is 0.4.9 / 0.3.10 — and earlier snapshots lagged further. Budget for drift between the
tutorial and current packages.

### Alternative ecosystem

- **[`@atcute/*`](https://codeberg.org/mary-ext/atcute)** (mary-ext) — ~50 modular ESM-first packages.
  `@atcute/client 5.1.1`, `@atcute/oauth-node-client 2.0.1`, `@atcute/lexicons 2.0.3`,
  `@atcute/jetstream 2.0.2`, `@atcute/tap 1.0.2`, `@atcute/lex-cli 3.2.1`, plus `xrpc-server` adapters
  for Cloudflare/Deno/Bun. Production use: Bookhive. One maintainer, fast breaking versions, no LTS.
  **Recommendation: official for auth, atcute opportunistically elsewhere.**
- **[`@skyware/*`](https://github.com/skyware-js)** — `@skyware/jetstream` (typed, auto-reconnect via
  partysocket), `@skyware/bot`. Mixed maintenance.
- **[hatk](https://github.com/bigmoves/hatk)** — the closest thing to an atproto ORM in TS. Generates
  DB tables from lexicon NSIDs, file-based `defineHook("on-commit", ...)`. **SQLite/DuckDB only — no
  Postgres adapter.** Alpha, one production user (Grain). Read it for ideas.
- **[tijs/atproto-oauth](https://github.com/tijs/atproto-oauth)** — plain Web `Request`/`Response`
  OAuth; the edge-compatible escape hatch.
- **[pilcrowonpaper/atproto-oauth-example](https://github.com/pilcrowonpaper/atproto-oauth-example)** —
  no SDK at all. Best for actually understanding PAR/DPoP.
- **[bluesky-social/cookbook](https://github.com/bluesky-social/cookbook)** — multi-language recipes, CC-0.
- **[goat](https://github.com/bluesky-social/goat)** — CLI. `goat lex pull/publish`, repo inspection.
  Install it; it's the fastest way to poke at real repos.
- **[sdk.blue](https://sdk.blue/)** — directory of atproto SDKs by language.

---

## Free network services (microcosm.blue et al.)

| Service                                                                                        | What                                                                                                                 | Buttery use                                                                                 |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Constellation](https://constellation.microcosm.blue/)                                         | Global backlink index, **every lexicon**. 27.3B DIDs / 16.8B linking records. `GET /links/all/count?target=<at-uri>` | **"Who saved / referenced this recipe"** for free, including from apps that don't exist yet |
| [Slingshot](https://slingshot.microcosm.blue/)                                                 | Edge cache: `getRecord`, `resolveHandle`, `blue.microcosm.identity.resolveMiniDoc`                                   | Replaces your identity cache + PDS fanout                                                   |
| [Hubble](https://atproto.com/blog/introducing-hubble-a-public-mirror-for-the-whole-atmosphere) | Whole-network repo mirror                                                                                            | Fallback when a user's PDS is offline                                                       |
| Spacedust                                                                                      | Filtered interactions firehose                                                                                       | No replay window, can't emit deletes yet                                                    |
| `pocket` (crate, early)                                                                        | _"personal-private atproto data service authorized by PDS service proxying"_                                         | **Watch** — relevant to private collections                                                 |

⚠️ These are largely one person's servers (Hubble partly grant-funded, ~1 year as of Mar 2026). Cache
aggressively, degrade gracefully, don't put them on a critical path.

---

## Community

- [awesome-lexicons](https://github.com/lexicon-community/awesome-lexicons) — where `exchange.recipe` is listed
- [lexicon.community](https://lexicon.community)
- [atproto.wiki working groups](https://atproto.wiki/en/working-groups/private-data)
- [@joshhuckabee.com](https://bsky.app/profile/joshhuckabee.com) — the recipe lexicon author. Worth
  talking to about the `maxLength` gap on `collection.recipes`, the dangling `knownValues`, and
  structured-ingredient extensions.
