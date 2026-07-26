# Buttery × atproto — Architecture Dossier: Overview & Decisions

**Compiled 2026-07-25.** All claims verified against primary sources on that date unless marked `[inferred]`.
This is the index doc. Read this one; open the others when you need the detail.

Stack context: TypeScript, TanStack Start, Kysely + Postgres, Railway. Hobby budget, room to grow.
Identity model: **bring-your-own atproto account** (no Buttery-hosted PDS).

---

## The five decisions, up front

### 1. No, you do not need to run a PDS. ✅ Settled

Buttery is an **AppView**, not a PDS. Users authenticate with their existing atproto account
(Bluesky or self-hosted); Buttery writes `exchange.recipe.*` records into _their_ repo via OAuth
and maintains a Postgres index for browse/search/social. "AppView" is a role, not software you
install — it means "you own an ingest pipeline and a database." You already have both.

Revisit only if you want `@name.buttery.app` handles as a product feature. That is an ops burden
(account migration, backups, moderation, abuse) with no benefit to the core recipe experience.

### 2. Yes, you will eventually want a firehose consumer — but not on day one, and not hand-rolled. ⚠️ Staged

The 2025-era advice ("write a Jetstream consumer") is **out of date**. Bluesky shipped **Tap**
(2025-12-12), a single Go binary that consumes the relay firehose, cryptographically verifies
commits, **auto-discovers and backfills every repo on the network containing a given collection**,
recovers from desync, manages cursors, and delivers events over WebSocket _or HTTP webhook_.

```
TAP_SIGNAL_COLLECTION=exchange.recipe.recipe
TAP_WEBHOOK_URL=https://buttery.app/api/ingest
```

Those two env vars replace the entire firehose-consumer project. Webhook mode means your
TanStack Start app stays stateless — only Tap is long-lived. ~$5–10/mo on Railway.

**Staging:** ship v1 with index-on-write + a cron reconciliation sweep (`$0` ingest). Add Tap when
you want cross-app recipes to appear in seconds rather than minutes. See `05-ingestion-and-sync`.

### 3. Private household data goes in your Postgres. There is no alternative today. ✅ Settled

atproto repos are unconditionally public — signed Merkle trees replicated to relays, with
unauthenticated `getRecord`/`listRecords` and a firehose broadcast on every write. There is no
visibility flag, no ACL, no unlisted concept. A third-party app **cannot** write private data to a
user's PDS.

This is not a compromise — it is what Bluesky itself does. Private bookmarks are XRPC procedures
against a server-side table, not records. DMs run on a separate service (`api.bsky.chat`).
Preferences are an auth-gated PDS-side blob, not a repo record. Tangled keeps ACLs on "knots."
Everyone with private data keeps it out of the repo.

The **Permissioned Data / "spaces"** work (proposals PR #94, Diary series through 2026-07-17) is
real and well-designed and explicitly names "bookmarks, drafts, private forums" as targets — but
it's a _draft_ with rough branch sketches. Realistically 2027 for third-party apps.

Design your private tables to be _record-shaped_ now so the eventual migration is a data move, not
a rewrite. See `06-private-vs-public-data`.

### 4. `exchange.recipe.collection` is an embedded array of strongRefs. This has a sharp edge. ⚠️ Act on this

The community lexicon models a cookbook as one record containing `recipes: array<com.atproto.repo.strongRef>`,
with **no maxLength**. That means:

- Every add/remove/reorder rewrites the entire record.
- Two devices editing the same cookbook **silently lose whole recipes** unless you use `putRecord`
  with `swapRecord` set to the CID you read. **Treat this as mandatory, not optional.**
- Practical ceiling ~100–200 recipes before you're fighting the record-size guidance; hard wall at
  the 2 MB firehose commit limit. `[inferred — arithmetic, not spec'd]`
- No reverse lookup: "which cookbooks contain this recipe" requires your Postgres index.

Use the community record as the **interop surface**; use your own `*.buttery.*` per-membership
records (the `app.bsky.graph.listitem` pattern) for high-churn Buttery-native features. See
`04-record-crud-and-collections`.

### 5. You cannot extend `exchange.recipe.recipe`. Plan around it. ✅ Settled

Lexicon evolution rules forbid adding required fields, changing types, or renaming — and you don't
own the schema anyway (`did:plc:4cx7ts7lqgjtsfquo53qo3sz`, @joshhuckabee.com). Every
Buttery-specific concept — structured ingredients with quantities, private notes, meal-plan slots,
cook-along step timings, household provenance — must live in **separate records under a namespace
you control**, or in Postgres.

Also: the publisher can `putRecord` a new schema version at any time. **Pin the current CID and
diff it in CI.** See `03-lexicons-and-recipe-schema`.

---

## Doc map

| Doc                              | Covers                                                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-identity-and-oauth`          | DIDs vs handles, DID docs, PDS discovery, `@atproto/oauth-client-node`, client metadata, scopes, session stores in Postgres, `requestLock`, writing on behalf of users, rate limits |
| `02-lexicons-and-recipe-schema`  | The verified `exchange.recipe.*` schemas verbatim, lexicon fundamentals, evolution rules, publishing/resolution, codegen with `@atproto/lex`                                        |
| `03-record-crud-and-collections` | `createRecord`/`putRecord`/`applyWrites`, record keys, `swapRecord` concurrency, CID churn, blobs, and the collection-modeling tradeoff                                             |
| `04-ingestion-and-sync`          | Tap, Jetstream, raw firehose, `listReposByCollection` backfill, cursors, idempotent upserts, the staged rollout                                                                     |
| `05-private-vs-public-data`      | Why repos are public, what Bluesky does, household modeling, the future-proofing checklist                                                                                          |
| `06-railway-topology-and-ops`    | Service layout, costs, private networking, cron, app-sleeping traps, the stable-domain constraint                                                                                   |
| `07-reference-index`             | Annotated links: specs, repos, reference apps, ecosystem services                                                                                                                   |
| `08-open-questions`              | What to verify empirically, what's likely to change, and the product decisions this research surfaced                                                                               |

---

## The one-paragraph mental model

A user's atproto account is a **public, signed, append-only key-value store** they own, addressed as
`at://<did>/<collection>/<rkey>`, replicated to relays and readable by anyone. Buttery never owns
that data — it _writes into it_ with the user's OAuth grant, and _reads from it_ via an index it
rebuilds from the firehose. Everything Buttery adds on top that isn't public — households, saves,
meal plans, notes — is ordinary app data in ordinary Postgres, keyed by DID, and Buttery is honest
with users that it lives on Buttery's servers. The public half is portable and interoperable; the
private half is a normal SaaS database until atproto ships spaces.

---

## Highest-value things to get right early

1. **Key everything on DID.** Never handle. Handles are DNS names and change freely.
2. **Attach your custom domain before your first real user.** `client_id` _is_
   `https://<domain>/client-metadata.json`. Changing domains changes your client identity and
   invalidates every session.
3. **`swapRecord` on every collection mutation.** Highest-severity data-loss bug available in this design.
4. **Pin the recipe lexicon CID and diff in CI.** Current: `bafyreid2sk4riiiibh7hjm5f7f74cc6iikby33wujupr2rhpupu`.
5. **Model private rows record-shaped** (stable rkey-ish id, collection-ish type name, `createdAt`,
   JSON value alongside typed columns) so the spaces migration is an export, not a rewrite.
6. **Ship a JSON export of all private data from day one.** It's your trust story _and_ your migration harness.
