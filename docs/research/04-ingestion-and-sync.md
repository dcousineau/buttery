# Ingestion & Sync — Do You Need a Jetstream Listener?

Verified 2026-07-25.

**Short answer: not on day one, and when you do, use Tap rather than hand-rolling a Jetstream
consumer.** The 2025-era "write a Jetstream consumer" advice is out of date.

---

## 1. What changed recently

Two things landed since most Jetstream tutorials were written, and both matter:

### Tap (2025-12-12) — the new blessed pattern

[atproto.com/blog/introducing-tap](https://atproto.com/blog/introducing-tap): _"a tool designed to
handle the hard parts of repo synchronization, so you can focus on building your application."_

A single Go binary (`ghcr.io/bluesky-social/indigo/tap:latest`), SQLite or Postgres backed, listening
on `:2480`. It does:

- **Automatic backfill** — _"When you begin tracking a repository, Tap fetches its complete history
  before delivering live events."_ Historical events are marked `live: false`; live events `live:
true` act as ordering barriers.
- **Cryptographic verification** — MST integrity, identity signatures, full Sync 1.1 semantics.
- **Recovery** — _"If a repo becomes desynchronized, Tap automatically resyncs from the authoritative
  PDS"_ with exponential backoff (1 min → 1 hr).
- **Cursor management**, invisible to you (`TAP_CURSOR_SAVE_INTERVAL`, default 1s).
- **Three delivery modes**: WebSocket with acks (default), fire-and-forget (`TAP_DISABLE_ACKS`), and
  **webhook** (`TAP_WEBHOOK_URL`) — _"for serverless applications."_

Guarantees **at-least-once with per-repository ordering**. Scales to _"millions of repos, 30k+
events/sec."_ There is an official TS client (`@atproto/tap`, `SimpleIndexer` / `LexIndexer`), a
Bluesky-authored [Railway deploy guide](https://github.com/bluesky-social/indigo/blob/main/cmd/tap/RAILWAY_DEPLOY.md),
and a [Railway template](https://railway.com/deploy/atproto-tap-example).

**The killer feature for Buttery:**

```bash
TAP_SIGNAL_COLLECTION=exchange.recipe.recipe
```

> _"track all repos with at least one record in this collection"_

That auto-discovers **and backfills** every recipe-publishing repo on the network. One env var
replaces the discovery + backfill project entirely.

### Hubble (2026-03-20) — public whole-network mirror

`hubble.microcosm.blue` serves `getRepo` / `listRepos` / `getRepoStatus`, filling the archival gap
left when relays went non-archival under sync v1.1. Free, grant-funded ($20k from Bluesky, covering
~one year as of Mar 2026). Current state only — no history, no blobs. **Use as a fallback when a
user's PDS is offline.**

---

## 2. Jetstream (still fine, but strictly dominated by Tap for your case)

Consumes `subscribeRepos`, decodes the CBOR/CAR MST blocks, re-emits lightweight JSON over
WebSocket. **No signatures, no MST proofs** — you're trusting the operator.

Public instances: `jetstream{1,2}.us-{east,west}.bsky.network`. Third-party:
`jetstream2.fr.hose.cam`, `jetstream.fire.hose.cam` (microcosm).

```
wss://jetstream2.us-west.bsky.network/subscribe?wantedCollections=exchange.recipe.recipe&compress=true&cursor=<unix_micros>
```

| Param               | Notes                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `wantedCollections` | NSIDs **or path prefixes** (`exchange.recipe.*`). Wildcards **only at period breaks** — `exchange.recipe.rec*` is invalid. Max 100. |
| `wantedDids`        | Max 10,000                                                                                                                          |
| `cursor`            | **Unix microseconds** (not a seq int — this is why Jetstream cursors survived the relay migration)                                  |
| `compress`          | zstd with a **custom shared dictionary** shipped at `pkg/models/zstd_dictionary` — you must load that exact dict                    |
| `requireHello`      | stream stays paused until you send an options-update; lets you set filters after connect                                            |

Event shape:

```json
{
  "did": "did:plc:...",
  "time_us": 1725911162329308,
  "kind": "commit",
  "commit": { "rev": "3l3qo2vutsw2b", "operation": "create", "collection": "exchange.recipe.recipe", "rkey": "3l3...", "record": {}, "cid": "bafyreid..." }
}
```

`operation` ∈ `create | update | delete` (no `record`/`cid` on delete). Plus `kind: "identity"` and
`kind: "account"` events.

⚠️ **`account` and `identity` events go to all subscribers regardless of your filters.** Budget for
network-wide identity churn even when filtering to one obscure NSID. Compressed, ~single-digit
GB/month `[inferred]`. (For scale: unfiltered Jetstream is ~850 MB/day compressed vs ~232 GB/day for
the raw firehose — 2024 figures, treat as a lower bound.)

Replay window: **~24 hours**.

### ⚠️ The known correctness bug

[jetstream#42](https://github.com/bluesky-social/jetstream/issues/42): during the cutover from cursor
replay to live-tailing, Jetstream **drops and reorders events** — typically ~0.5–1 s of events vanish
(one reproduction lost 547), and `time_us` is not monotonic across the boundary. The emit path
discards "stale" replay events once a live event lands, even though replay hasn't drained. Still open
at last check.

> _"a client wishing to process a complete event log cannot currently rely on jetstream to deliver
> all events."_

**A Jetstream-only design needs a reconciliation job regardless.**

Also: the `main` branch README of `bluesky-social/jetstream` describes a **rewrite** ("a full-network
archive and streaming service") carrying _"not yet deployed to production, backwards-incompatible
changes to the on-disk format."_ The deployed instances implement the classic protocol above. Don't
build against `main`'s docs.

---

## 3. The raw firehose — you almost certainly don't need it

`com.atproto.sync.subscribeRepos`, binary WebSocket, DAG-CBOR. Messages: `#commit`, `#identity`,
`#account`, `#sync`, `#info`. (`#handle`, `#migration`, `#tombstone` fully removed.)

**Sync v1.1 did not remove inlined blocks** — it added to them: `prevData` (previous MST root CID, so
a commit validates standalone), more inlined MST nodes for operation inversion, and `ops[].prev`.
`#sync` is the new "this is the current state of the repository" assertion.

Cursor is a **relay-local monotonic `seq`, not portable across relays**. This bit Bluesky itself: the
2026-01-27 relay transition from `narelay.pop2.bsky.network` to `relay1.us-west.bsky.network` caused
_"a significant delta"_ jump and duplicated events for firehose consumers. Jetstream consumers were
unaffected (timestamp cursors).

Relay backfill window ~24 h; **relays are now explicitly non-archival**.

Reach for raw `subscribeRepos` only if you need signature verification, MST integrity, your own
relay/mirror, or seq-exact resumption — and note **Tap gives you the first two without the CBOR/CAR
code**.

---

## 4. Backfill: bootstrapping every recipe on the network

### `com.atproto.sync.listReposByCollection` — the key endpoint

```
GET /xrpc/com.atproto.sync.listReposByCollection
    ?collection=exchange.recipe.recipe   (required, nsid)
    &limit=1..2000 (default 500)
    &cursor=<opaque>
→ { "cursor": "...", "repos": [ { "did": "did:plc:..." } ] }
```

> _"Enumerates all the DIDs which have records with the given collection NSID."_

Served by the new relays (`relay1.us-{east,west}.bsky.network`) via a `collectiondir` microservice.
Noted as _"not strictly required by the protocol"_ — don't assume every relay has it.

**The whole backfill reduces to:**

1. Page `listReposByCollection?collection=exchange.recipe.recipe` → set of DIDs
2. Resolve each DID → PDS endpoint
3. `com.atproto.repo.listRecords?repo=<did>&collection=exchange.recipe.recipe&limit=100&cursor=...`
   (unauthenticated)
4. Idempotent upsert

⚠️ `collectiondir` is built from observed firehose traffic, so coverage starts whenever it started
indexing. Best available enumeration, not provably complete. `[inferred]`

### Other options

| Tool                                               | Use                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `com.atproto.sync.getRepo`                         | Full CAR export per DID, unauthenticated. Right for **repairing one desynced repo**, wrong for network sweeps.                                                                                                                                                                                                    |
| `com.atproto.sync.listRepos`                       | Enumerates _all_ accounts (tens of millions). Absurd for one NSID.                                                                                                                                                                                                                                                |
| **Hubble**                                         | Whole-network mirror; fallback when a user's PDS is offline.                                                                                                                                                                                                                                                      |
| **Constellation** (`constellation.microcosm.blue`) | Global **backlink index** — "what links to this at-uri?", by collection and JSON path. 27.3 B DIDs / 3.65 B targets / 16.8 B linking records, indexing since 2025-01-28. Works with **every** lexicon. **This is a free "who saved / referenced this recipe" feature**, including from apps that don't exist yet. |
| **Slingshot**                                      | Edge cache for `getRecord`, `resolveHandle`, and `resolveMiniDoc` identity resolution. Cheaper than hammering PDSes and `plc.directory`.                                                                                                                                                                          |
| **Spacedust**                                      | Filtered interactions firehose. No replay window, can't emit deletes today.                                                                                                                                                                                                                                       |

Caveat on the microcosm services: one person's servers (Hubble partly grant-funded). Cache
aggressively, degrade gracefully.

---

## 5. The staged recommendation for Buttery

### Stage 1 (launch) — index-on-write + cron sweep. **$0 ingest.**

- When a user creates/edits a recipe in Buttery, write to their PDS **and** upsert to Postgres in the
  same flow (via the outbox pattern in `01-identity-and-oauth` §4).
- A Railway cron service runs `listReposByCollection` + per-DID `listRecords`, diffs against
  Postgres, and reconciles. Catches edits made in recipe.exchange or any other app.
- `exchange.recipe.recipe` is a **low-volume NSID** — a full network sweep is plausibly minutes, not
  hours. `[inferred]` Measure it once and set the cron interval from that.
- Freshness = cron interval. Railway cron minimum is 5 minutes.

### Stage 2 — add Tap when any of these is true

- Cross-app recipes must appear in **seconds**, not minutes
- The sweep starts taking >5 minutes
- You want verified provenance
- You want per-event semantics (notifications: "someone added your recipe to a cookbook")

```bash
TAP_DATABASE_URL=$DATABASE_URL          # reuse Postgres; avoids a 2nd Railway volume
TAP_SIGNAL_COLLECTION=exchange.recipe.recipe
TAP_COLLECTION_FILTERS=exchange.recipe.recipe,exchange.recipe.collection,exchange.recipe.profile
TAP_WEBHOOK_URL=https://buttery.app/api/ingest
TAP_ADMIN_PASSWORD=<random>
TAP_RELAY_URL=https://relay1.us-east.bsky.network
TAP_LOG_LEVEL=error
```

Webhook mode means **your TanStack Start app stays stateless and horizontally scalable** — Tap is the
only long-lived stateful service. Cost ≈ **$5–10/mo** on Railway `[inferred]`; Railway's own
statusphere template page cites **~$1.50/mo** for full-network Status aggregation.

Tap event shape:

```json
{ "id": 12345, "type": "record",
  "record": { "live": true, "rev": "3kb3fge5lm32x", "did": "did:plc:abc123",
              "collection": "exchange.recipe.recipe", "rkey": "3kb3...",
              "action": "create", "cid": "bafyreig...", "record": { } } }
{ "id": 12346, "type": "identity",
  "identity": { "did": "did:plc:abc123", "handle": "alice.bsky.social",
                "isActive": true, "status": "active" } }
```

`status` ∈ `active | takendown | suspended | deactivated | deleted`.

Admin API: `GET /health`, `WS /channel`, `POST /repos/add`, `POST /repos/remove`, `GET /resolve/:did`,
`GET /info/:did`, `GET /stats/{repo-count,record-count,outbox-buffer,resync-buffer,cursors}`.

### Stage 3 — raw `subscribeRepos`

Only if Tap's abstractions genuinely block you. Not before.

### The option to skip

**Hand-rolling a Jetstream consumer.** Same always-on container cost as Tap, strictly less
functionality (no verification, no backfill, no desync recovery, manual cursors), plus the open
drop/reorder bug at replay cutover. The only argument for it is avoiding a Go binary you don't
control — and Tap is first-party Bluesky code in `indigo`.

---

## 6. Idempotency, ordering, and drift — the patterns that matter

### Idempotent upsert keyed on `(did, collection, rkey)`, guarded by `rev`

`rev` is a TID: lexicographically sortable, monotonic per repo. That makes writes **order-insensitive
and duplicate-safe**:

```sql
insert into recipe (did, rkey, cid, rev, record, indexed_at)
values ($1,$2,$3,$4,$5, now())
on conflict (did, rkey) do update
  set cid = excluded.cid, rev = excluded.rev,
      record = excluded.record, indexed_at = now()
where recipe.rev < excluded.rev;
```

Both Jetstream and Tap are explicitly **at-least-once**. Every write must be an idempotent upsert.

### Ordering

> _"Stream events can be processed concurrently across accounts, but they should be processed
> sequentially in-order for any given account."_

**Shard your worker pool by DID, never round-robin.** Tap already guarantees per-repo ordering.

### Cursors

Persist **transactionally with the batch of writes it covers**. On reconnect, rewind — Jetstream's
guidance is "a few seconds"; given issue #42, use **30–60 seconds**. `[inferred]`

Beyond the ~24 h replay window you cannot rewind — you must backfill. **A weekend of downtime on a
hobby project will exceed the window**, so the repair path must exist from day one, not be added
after the first incident.

### Deletes and account status

- Prefer **soft delete** (`deleted_at`) over row removal, so a late duplicate delete is idempotent and
  a subsequent create with a higher `rev` resurrects correctly.
- The old `#tombstone` no longer exists; account deletion arrives as an account/identity event with
  `status: "deleted"`.
- Handle `takendown | suspended | deactivated | deleted`: hide from public browse, **retain rows**.
  Only hard-purge on `deleted`, on your own retention schedule. `deactivated` frequently reverses.
  `[inferred on policy]`
- Identity events are _"best-effort"_ — use them to invalidate a cache, never as truth. Re-resolve.

### Batching

Buffer ~100–500 events or ~250 ms, whichever first, one multi-row upsert per batch, **partitioned by
DID so per-repo ordering survives**. `[inferred]`

### Reconciliation

**Keep the cron sweep even after adding Tap.** It's your only defense against silent index drift, and
for a single low-volume NSID it's cheap. Weekly is plenty once Tap is live.

---

## Sources

[Introducing Tap](https://atproto.com/blog/introducing-tap) ·
[Tap README](https://github.com/bluesky-social/indigo/blob/main/cmd/tap/README.md) ·
[Tap Railway guide](https://github.com/bluesky-social/indigo/blob/main/cmd/tap/RAILWAY_DEPLOY.md) ·
[@atproto/tap](https://github.com/bluesky-social/atproto/blob/main/packages/tap/README.md) ·
[Jetstream](https://github.com/bluesky-social/jetstream) ·
[jetstream#42](https://github.com/bluesky-social/jetstream/issues/42) ·
[jazco.dev on Jetstream](https://jazco.dev/2024/09/24/jetstream/) ·
[Sync spec](https://atproto.com/specs/sync) ·
[Proposal 0006 sync-iteration](https://github.com/bluesky-social/proposals/blob/main/0006-sync-iteration/README.md) ·
[Relay updates / sync v1.1](https://atproto.com/blog/relay-updates-sync-v1-1) ·
[Relay rollout](https://atproto.com/blog/relay-rollout) ·
[Introducing Hubble](https://atproto.com/blog/introducing-hubble-a-public-mirror-for-the-whole-atmosphere) ·
[microcosm.blue](https://www.microcosm.blue/) ·
[constellation](https://constellation.microcosm.blue/) ·
[listReposByCollection lexicon](https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/sync/listReposByCollection.json)

**Could not verify:** Jetstream public-instance rate/connection limits (undocumented anywhere I
could find); whether Bluesky operates a public hosted Tap instance (not mentioned — assume self-host).
