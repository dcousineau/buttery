# atproto Research Dossier

Compiled **2026-07-25** by Claude (Cowork) in response to the prompt reproduced at the bottom of this
file. Every claim was verified against primary sources on that date unless explicitly marked
`[inferred]`. Sources are cited inline throughout.

**This is a point-in-time snapshot.** atproto moved significantly in the six months before this was
written (Tap, sync v1.1, granular OAuth scopes, permissioned-data drafts). Re-verify before acting on
anything load-bearing, and see `08-open-questions.md` for the specific things most likely to drift.

---

## Contents

| File                                                                       | Covers                                                                                                                                                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`00-overview.md`](./00-overview.md)                                       | **Start here.** The five architecture decisions, the mental model, and the highest-value things to get right early.                                                                                          |
| [`01-identity-and-oauth.md`](./01-identity-and-oauth.md)                   | DIDs vs handles, DID docs, PDS discovery, `@atproto/oauth-client-node`, client metadata, scopes, session stores in Postgres, `requestLock`, writing on behalf of users, rate limits, TanStack Start pitfalls |
| [`02-lexicons-and-recipe-schema.md`](./02-lexicons-and-recipe-schema.md)   | The verified `exchange.recipe.*` schemas, lexicon fundamentals, evolution rules, publishing/resolution, codegen with `@atproto/lex`                                                                          |
| [`03-record-crud-and-collections.md`](./03-record-crud-and-collections.md) | `createRecord`/`putRecord`/`applyWrites`, record keys, `swapRecord` concurrency, CID churn, blobs, and the collection-modeling tradeoff                                                                      |
| [`04-ingestion-and-sync.md`](./04-ingestion-and-sync.md)                   | Tap, Jetstream, raw firehose, `listReposByCollection` backfill, cursors, idempotent upserts, the staged rollout                                                                                              |
| [`05-private-vs-public-data.md`](./05-private-vs-public-data.md)           | Why repos are unconditionally public, what Bluesky itself does, household modeling, the future-proofing checklist                                                                                            |
| [`06-railway-topology-and-ops.md`](./06-railway-topology-and-ops.md)       | Service layout, costs, private networking, cron, app-sleeping traps, the stable-domain constraint                                                                                                            |
| [`07-reference-index.md`](./07-reference-index.md)                         | Annotated links: specs, repos, reference apps, ecosystem services, package versions                                                                                                                          |
| [`08-open-questions.md`](./08-open-questions.md)                           | What to verify empirically, what's likely to change, and the product decisions this research surfaced                                                                                                        |

---

## Summary of findings

### 1. No, Buttery does not need to run a PDS

Buttery is an **AppView**, not a PDS. Users authenticate with their existing atproto account and
Buttery writes `exchange.recipe.*` records into _their_ repo via OAuth, maintaining a Postgres index
for browse/search/social. "AppView" is a role, not software you install — it means "you own an ingest
pipeline and a database." Revisit only if `@name.buttery.app` handles become a product goal.

### 2. You don't need a Jetstream listener — that pattern is obsolete

The 2025-era "write a Jetstream consumer" advice is out of date. Bluesky shipped **Tap**
(2025-12-12), a Go binary that consumes the relay firehose, cryptographically verifies commits,
**auto-discovers _and backfills_ every repo on the network containing a given collection**, recovers
from desync, manages cursors, and delivers events over WebSocket _or HTTP webhook_.

```bash
TAP_SIGNAL_COLLECTION=exchange.recipe.recipe
TAP_WEBHOOK_URL=https://buttery.app/api/ingest
```

Those two env vars replace the entire firehose-consumer project. Webhook mode keeps the TanStack
Start app stateless — only Tap is long-lived. ~$5–10/mo on Railway, with a Bluesky-authored Railway
deploy guide and template.

Hand-rolled Jetstream is strictly dominated: same always-on cost, no verification, no backfill, no
desync recovery, manual cursors, **plus an open bug ([#42](https://github.com/bluesky-social/jetstream/issues/42))
that silently drops ~0.5–1s of events at replay cutover.**

**Recommended staging:** ship v1 on index-on-write + a cron reconciliation sweep (**$0 ingest**); add
Tap when cross-app recipes need to appear in seconds rather than minutes, or when the sweep exceeds
~5 minutes. Keep the sweep even after adding Tap — it's the only defense against silent index drift.

### 3. Private household data goes in Postgres — and that isn't a compromise

atproto repos are unconditionally public: signed Merkle trees replicated to relays, with
unauthenticated `getRecord`/`listRecords` and a firehose broadcast on every write. There is no
visibility flag, no ACL, no unlisted concept. **A third-party app cannot write private data to a
user's PDS.**

This is exactly what Bluesky itself does. Private bookmarks are XRPC procedures against a server-side
table, not records. DMs run on a separate service (`api.bsky.chat`) and are not E2EE. Preferences are
an auth-gated PDS-side blob. Tangled keeps ACLs on self-hosted "knots." Nobody puts private data in a
repo, because nobody can.

The **Permissioned Data / "spaces"** work (proposals PR #94, Diary series through 2026-07-17) is real,
well-designed, and explicitly names "bookmarks, drafts, private forums" as targets — but it's a
_draft_ with rough branch sketches. 2027 at the earliest for third-party apps. Notably, atproto has
**explicitly declined** to design E2EE for it.

Design private tables to be _record-shaped_ now (stable TID-ish id, collection-shaped type name,
`createdAt`, JSON `value` alongside typed columns) so the eventual migration is a data move rather
than a rewrite. `05-private-vs-public-data.md` has the household schema and a full future-proofing
checklist.

### 4. The recipe lexicon is real, verified — and has two sharp edges

Resolution chain verified end to end: `_lexicon.recipe.exchange` TXT → `did:plc:4cx7ts7lqgjtsfquo53qo3sz`
→ four `com.atproto.lexicon.schema` records. Recipe schema CID
`bafyreid2sk4riiiibh7hjm5f7f74cc6iikby33wujupr2rhpupu` — **pin it and diff in CI**, since the
publisher can `putRecord` a new version at any time.

**Edge 1 — silent data loss.** `exchange.recipe.collection` embeds the whole recipe array as
`strongRef[]` with **no `maxLength`**. Two devices editing one cookbook will **silently lose whole
recipes** unless every mutation is `putRecord` with `swapRecord` set to the CID you read. This is the
highest-severity bug available in this design space. Also: practical ceiling ~100–200 recipes before
fighting record-size guidance, hard wall at the 2 MB firehose commit limit.

**Edge 2 — broken vocabularies.** The `knownValues` for `recipeCategory`, `recipeCuisine`,
`cookingMethod`, and `suitableForDiet` all point at defs that **don't exist** in
`exchange.recipe.defs` (which defines `categoryAppetizer`, `cuisineItalian`, … instead). Harmless —
`knownValues` is non-enforcing — but there's no machine-readable enum, so hardcode from `defs.json`
and be liberal on read.

**And you cannot extend `exchange.recipe.recipe`.** Lexicon evolution rules forbid it and you don't
own the schema. Structured ingredients (the lexicon's `ingredients` is a flat `string[]`), private
notes, meal-plan slots, and cook-along timings must live in your own namespace or in Postgres. Steal
Bookhive's "hive" split: canonical parsed catalog in the app DB, PDS record carries a pointer plus
the user's own opinion.

### 5. Statusphere was rewritten and is now a near-perfect template

`bluesky-social/statusphere-example-app` `main` is **Next 16 + React 19 + `@atproto/lex` +
`@atproto/tap` + Kysely + better-sqlite3**. Swap Next → TanStack Start and SQLite → Postgres and you
have Buttery's skeleton; its OAuth store implementations are near-copy-paste. (The old Express +
in-process-firehose version is on branch `statusphere-og`. Note `atproto.com/guides/applications` is
stale and still describes that era.)

**Caveat: there are zero public examples of atproto OAuth in TanStack Start.** Budget a day.
`01-identity-and-oauth.md` §5 lists the specific traps — the callback must be a server _route_ not a
`createServerFn`; Node 22 not 24; the `localhost` vs `127.0.0.1` loopback asymmetry; Vite
`ssr.external`; the cookie-read-after-set bug.

### 6. Act on this before your first real user

`client_id` **is** `https://<your-domain>/client-metadata.json` — the URL is the identity, and the
user's PDS fetches it server-to-server. **Changing your domain invalidates every session and forces
re-consent from every user.** Attach the custom domain before launch; don't ship on
`*.up.railway.app` and migrate later. That document and `/.well-known/jwks.json` must also be
publicly reachable — no Cloudflare Access, no bot challenge, no basic auth.

Other early-decision items: key everything on **DID**, never handle. Use a **confidential** OAuth
client (180-day refresh tokens vs 2 weeks for public). Implement `requestLock` with a Postgres
advisory lock before you scale past one replica, or concurrent refreshes will destroy sessions. Ship
a JSON export of all private data from day one — it's your trust story _and_ your migration harness.

---

## Provenance

Research was fanned out across five parallel agents (identity/OAuth, lexicons/schema, ingestion/sync,
private-data patterns, TS ecosystem/reference apps), then key claims were re-verified directly
against primary sources: the raw `exchange.recipe.*` lexicon JSON, the Tap README and announcement,
the atproto scopes guide, and the live `statusphere-example-app` `package.json`.

Claims are marked where they're inferred rather than verified, and `08-open-questions.md` lists
everything that couldn't be pinned down — including undocumented Jetstream rate limits, the exact
accepted OAuth scope string (the canonical spec page 404s), and the intended wire format for the
recipe vocabulary fields.

---

## Original prompt

> I need you to do deep research to setup context in this project for working on ATProto (@proto)
> projects. Specifically I'd like you to be prepared for me to ask architecture questions about how
> to build this project (e.g. will I need ot create a PDS, should I create listeners to the
> 'jetstream' to sync with recipe data in order to interact with it).
>
> One note as you're pulling in research to help epxand your radius: this project will be mixing
> private and public atproto data. I envision a world where the actual recipe data is public,
> published to atproto, but having private collections in my own database so users can build up a
> "household" set of recipes they care about but said household data is mostly private.

### Clarifying answers that scoped the research

**Project state** — "Have started a codebase, typescript based tanstack start with kysely for db
connections to postgres. It's extremely early though and not much functionality has yet to be built,
but we have access to semi-advanced infrastructure abilities (like serverless fns, multiple services,
cron jobs, multiple databases, etc) via Railway. My goal is to keep costs down as this is a hobby
project but be prepared if I want to expand the scope of the project"

**Identity model** — Bring-your-own account. Users sign in with an existing Bluesky/atproto handle via
OAuth; Buttery writes to their PDS. No PDS to run.

**Depth & output** — Deep architecture dossier: multiple docs covering atproto primer, identity/auth,
data model & lexicons, ingestion (Jetstream/firehose), private+public hybrid patterns, ops on
Railway. Heavy on code-level specifics.

**Priority topics** — Private/public data split · Jetstream & sync strategy · Lexicon & schema design ·
Modifying/updating existing records on atproto (specifically recipe collections)
