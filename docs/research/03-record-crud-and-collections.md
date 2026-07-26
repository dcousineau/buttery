# Record CRUD & Modeling Collections

Verified 2026-07-25 against the canonical lexicon JSON in `bluesky-social/atproto/lexicons/com/atproto/repo/`.

This doc answers the "how do I update records, especially recipe collections" question directly.

---

## 1. The write endpoints

### `com.atproto.repo.createRecord` (procedure)

| In           | Type                           | Req |
| ------------ | ------------------------------ | :-: |
| `repo`       | at-identifier                  |  ✔  |
| `collection` | nsid                           |  ✔  |
| `record`     | unknown (must contain `$type`) |  ✔  |
| `rkey`       | record-key, ≤512               |     |
| `validate`   | boolean                        |     |
| `swapCommit` | cid                            |     |

Out: `uri` (at-uri, req), `cid` (req), `commit` (`{cid, rev}`), `validationStatus` (`"valid"|"unknown"`).
Error: `InvalidSwap`.

### `com.atproto.repo.putRecord` (procedure)

Same as above, but **`rkey` is required**, and it adds `swapRecord` (cid, **nullable**).
Creates-or-replaces. Error: `InvalidSwap`.

### `com.atproto.repo.deleteRecord`

`repo`, `collection`, `rkey` required; `swapRecord`, `swapCommit` optional.

### `com.atproto.repo.listRecords` (query, **no auth**)

`repo` ✔, `collection` ✔, `limit` 1–100 (default **50**), `cursor`, `reverse`.
Out: `records: [{uri, cid, value}]`, `cursor`.

Records come back in **rkey order**. With TID rkeys that's chronological, so `reverse: true` gives
newest-first. **This endpoint is unauthenticated** — it is how you read anyone's recipes, and it's
the backbone of backfill and reconciliation.

### `com.atproto.repo.describeRepo` (query, no auth)

→ `{handle, did, didDoc, collections, handleIsCorrect}`. `collections` lists every NSID with ≥1
record.

⚠️ **Use this at onboarding** to detect that a new Buttery user already has recipes written by
recipe.exchange or another app, and offer to import/index them rather than starting them empty.
That's a genuinely great first-run experience and it's one API call.

### `com.atproto.repo.applyWrites` — the only atomicity primitive

`writes`: array of union `#create | #update | #delete`.

- `#create`: `collection` ✔, `value` ✔, `rkey` optional
- `#update`: `collection` ✔, `rkey` ✔, `value` ✔
- `#delete`: `collection` ✔, `rkey` ✔

Out: `results` of `#createResult`/`#updateResult` (`uri`, `cid`, `validationStatus`) / `#deleteResult`.

**All writes land in a single commit.** No `maxLength` on `writes` in the lexicon, but PDS
implementations impose their own — don't send thousands. Note the rate-limit cost doesn't change:
still 3 points per created record.

### `validate` is three-state, not boolean

> _"Can be set to 'false' to skip Lexicon schema validation of record data, 'true' to require it, or
> leave unset to validate only for known Lexicons."_

**Leave it unset for `exchange.recipe.*`.** If the PDS knows the schema you get enforcement;
otherwise it stores and returns `unknown`. Setting `true` against a PDS that hasn't loaded the
community lexicon would fail your writes. Validate client-side with the generated types.

---

## 2. Record keys

Four types: **`tid`** (most common — `3jzfcijpj2z2a`), **`nsid`**, **`literal:self`** (singletons),
**`any`**.

Syntax: `[A-Za-z0-9.\-_:~]`, 1–512 chars, not `.` or `..`, case-sensitive (lowercase recommended).

Two warnings from the spec:

> _"Implementations should not rely on global uniqueness of TIDs, and should not trust TID timestamps
> as actual record creation timestamps."_

`(did, collection, rkey)` is unique. `(did, rkey)` is **not**.

**For Buttery:** recipes → `tid`, collections → `tid` (both mandated by the lexicon's `key: tid`),
profile → `literal:self` (mandated). **Never derive rkeys from user-supplied slugs** — you'd leak
titles into permanent URIs and collide.

---

## 3. Optimistic concurrency — read this section twice

### The two CAS mechanisms

|              | Compares against                  | Use for                                                                                                                                                                       |
| ------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `swapRecord` | the specific record's current CID | **Every Buttery edit.** Pass the CID you read; a concurrent write yields `InvalidSwap` instead of silently clobbering. `swapRecord: null` asserts "must not currently exist." |
| `swapCommit` | the whole repo's commit CID       | Almost nothing. Any unrelated write in the user's repo invalidates it — far too strict for a multi-device user.                                                               |

### Why this is the highest-severity bug available to you

`exchange.recipe.collection` embeds the **entire recipe array in one record**. Without `swapRecord`:

```
Phone:   read collection (5 recipes) → add Recipe F → putRecord → 6 recipes
Laptop:  read collection (5 recipes) → add Recipe G → putRecord → 6 recipes  ← F is gone
```

A lost update here drops **whole recipes from a cookbook**, not a field. And it's silent.

**Rule: every mutation of a `collection` record is `putRecord` with `swapRecord` set to the CID you
last read.** On `InvalidSwap`: re-read, merge (set-union on the recipe URIs is usually the right
merge for adds; for reorders, prompt), retry once, then surface a conflict.

Store the last-seen CID in your Postgres row so you always have something to swap against.

---

## 4. CID churn — what happens on update

**Yes, the CID changes on every update.** Records are content-addressed: changing any byte yields a
new CID → new MST leaf → new MST root → new signed commit (`did`, `version: 3`, `data`, `rev`
monotonic, `prev` — virtually always null, `sig`).

`com.atproto.repo.strongRef` is `{uri: at-uri, cid: cid}` — "a URI with a content-hash fingerprint."

**So every strongRef to a recipe goes stale the moment that recipe is edited.** The `uri` still
resolves; the `cid` no longer matches current content. This is exactly the
`exchange.recipe.collection.recipes` situation, and it is _by design_ — Bluesky's convention is that
a strongRef pins "the version I saw."

**Buttery's handling** `[inferred]`:

- Resolve collection members **by `uri`**; treat a CID mismatch as _"this recipe has been updated
  since it was added to your cookbook"_ — surface it, don't error.
- Optionally refresh stored CIDs on the next collection write.
- If you want true immutability ("the version I actually cooked"), you must **store a copy** — PDSes
  don't retain history addressable by old CID.

That last point is a genuinely nice product feature for a recipe app: _"Grandma's brisket, as it was
when you saved it — the author has since changed the oven temp. View current version?"_

---

## 5. Blobs and images

Two-phase: `com.atproto.repo.uploadBlob` (input `*/*`, output `{blob}`) → embed the returned blob
object in a record → `createRecord`/`putRecord`.

⚠️ **Garbage collection is aggressive and real:**

> _"The blob will be deleted if it is not referenced within a time window (eg, minutes)."_

**Never upload at form-open time and hope it survives a long edit session.** Upload immediately
before the record write. For a recipe editor where someone drops a photo then spends 20 minutes
typing steps, this means: hold the file client-side (or in Buttery's own storage), and upload to the
PDS as part of the save action.

Limits:

- PDS blob upload hard max **50 MB**
- **`exchange.recipe.recipe#image` caps at `maxSize: 1000000` (1 MB), `accept: image/*`, max 4
  images.** Client-side compress/resize or the write fails validation.
- `alt` is **required** on every image.

Blobs live in the _user's_ PDS, fetched via `com.atproto.sync.getBlob`. For the big-and-bright
cook-along display you want a **Buttery-side CDN cache** — recipe.exchange does exactly this (see
their `#viewImage` "CDN location provided by recipe.exchange"), and you don't want a cooking display
stalling on someone's home-connection PDS.

---

## 6. Hard limits

| Thing                  | Limit                                                                   |
| ---------------------- | ----------------------------------------------------------------------- |
| Record size            | No spec limit; guidance "a few dozen KBytes", **1 MiB recommended max** |
| Single firehose commit | **2,000,000 bytes** — the real wall                                     |
| Ops per commit         | 200                                                                     |
| Nesting depth          | ≤32                                                                     |
| Elements per container | ≤131,072                                                                |
| Integers               | ±2^53−1                                                                 |
| Records per repo       | "single-digit millions… beyond that they become unwieldy"               |
| Write points           | CREATE 3 / UPDATE 2 / DELETE 1; **5,000/hr, 35,000/day per account**    |

---

## 7. Modeling collections — the central design question

### The patterns

**(a) Embedded array of strongRefs in one record** — what `exchange.recipe.collection` does.

- ✅ Ordering free and explicit (array index). Reorder = one write. Read = one `getRecord`. Atomic.
- ❌ Every mutation rewrites the whole record. Every mutation invalidates concurrent editors'
  `swapRecord`. **Size ceiling**: a strongRef is ~200–250 bytes (at-uri + CIDv1 string), so ~4,000
  refs against the 1 MiB guidance, **~100–200 comfortably** `[inferred — arithmetic]`. **No reverse
  lookup** — "which collections contain recipe X" requires scanning every collection record on the
  network.

**(b) One record per membership** — `app.bsky.graph.listitem` (key `tid`): required `subject`,
`list` (at-uri), `createdAt`. The _list_ record holds **no members at all**.

- ✅ Unbounded. Add/remove = one small write, **no read-modify-write, so the lost-update class of
  bug doesn't exist**. Reverse-indexable. Firehose-friendly (a subscriber sees "recipe added to
  cookbook" as a discrete event, which is what you want for notifications).
- ❌ **No intrinsic ordering** — listitem has no position field. Reordering rewrites many records.
  Reading one collection's members = `listRecords` + filter, i.e. **you need an index**.

**(c) `list` + `listitem`** — the container/membership split. `app.bsky.graph.list` holds `name`,
`purpose`, `description`, `avatar`; membership lives entirely in separate records.

**(d) Starter-pack hybrid** — `app.bsky.graph.starterpack` delegates the unbounded set to a
list+listitem, and embeds a small curated set inline (`feeds`, **maxLength 3**). Bluesky drew the
line at 3.

### Comparison

|                 | (a) embedded array                    | (b/c) per-membership     |
| --------------- | ------------------------------------- | ------------------------ |
| Add/remove cost | rewrite whole record                  | one tiny write           |
| Ordering        | free, explicit                        | absent; needs convention |
| Size ceiling    | ~1 MiB record / 2 MB commit           | none                     |
| Concurrent edit | **lost updates without `swapRecord`** | conflict-free            |
| Reverse lookup  | full scan                             | direct                   |
| Read            | 1 request                             | index required           |

### Recommendation for Buttery: do both, deliberately

1. **Write `exchange.recipe.collection` (pattern a) as the interop surface.** It's what the community
   lexicon defines and what recipe.exchange and future apps will read. You get ordering free, which
   matters for a cookbook. **`swapRecord` on every mutation — mandatory.**

2. **Cap public collections in the UI at a few hundred recipes** and warn beyond that. The lexicon
   sets no `maxLength`, which is arguably a schema bug; the 2 MB commit limit bites as a _failed
   write on a large cookbook_, which is a terrible thing to discover late. Consider filing this
   upstream with joshhuckabee.

3. **For Buttery-native, high-churn features — meal planner, shopping list, cook-along state — use
   pattern (b) in a namespace you control.** One `<your-authority>.plan.entry` record per meal-plan
   slot with `recipe: strongRef`, `date`, `slot` avoids read-modify-write entirely and gives clean
   per-event firehose semantics. _If_ they should be public at all — see below.

4. **Private household collections are not records.** No visibility field exists (`02-lexicons`,
   §3). They're Postgres. Model them as pattern (b) rows — a `household_collection_item` table — for
   exactly the same reasons, and so they're record-shaped when spaces ship (`05-private-vs-public`).

5. **Maintain the Postgres index regardless.** Reverse lookups, search, the cook-along display, and
   "which of my cookbooks contain this" all need it. **PDS is the system of record; Postgres is a
   rebuildable cache** keyed by `(did, collection, rkey)` with the last-seen `cid`.

### Sketch

```sql
-- public mirror, rebuildable from the network
create table recipe (
  did          text not null,
  rkey         text not null,
  uri          text generated always as ('at://'||did||'/exchange.recipe.recipe/'||rkey) stored,
  cid          text not null,
  rev          text not null,          -- TID, monotonic per repo → ordering guard
  record       jsonb not null,         -- raw, unlossy: preserve other apps' unknown fields
  name         text,                   -- projections for search
  validity     text not null default 'valid',   -- valid | unknown | invalid
  indexed_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  primary key (did, rkey)
);

create table collection_member (       -- flattened from the embedded array, for reverse lookup
  collection_did text not null, collection_rkey text not null,
  position       int  not null,
  recipe_uri     text not null,
  recipe_cid     text not null,        -- the pinned version; mismatch ⇒ "updated since saved"
  primary key (collection_did, collection_rkey, position)
);
create index on collection_member (recipe_uri);   -- ← the reverse lookup pattern (a) can't do
```

---

## Sources

Canonical lexicons under
[bluesky-social/atproto/lexicons/com/atproto/repo](https://github.com/bluesky-social/atproto/tree/main/lexicons/com/atproto/repo) ·
[Repository spec](https://atproto.com/specs/repository) ·
[Record key spec](https://atproto.com/specs/record-key) ·
[Rate limits](https://docs.bsky.app/docs/advanced-guides/rate-limits) ·
[recipe.exchange lexicons](https://recipe.exchange/lexicons/)
