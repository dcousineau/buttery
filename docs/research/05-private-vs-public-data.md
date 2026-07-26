# Private vs. Public: Households, Saves, and the Postgres Half of Buttery

Verified 2026-07-25. This is the doc for the hardest part of Buttery's design.

---

## 1. The definitive answer

**A third-party app cannot write private data to a user's PDS today. Full stop.**

A repo is a signed Merkle tree replicated to relays. `com.atproto.repo.getRecord` and `listRecords`
are **unauthenticated** read endpoints. Every write emits a firehose `#commit`. There is no
visibility flag, no ACL field, no "unlisted" concept anywhere in the repo spec. Every write path
(`createRecord`, `putRecord`, `applyWrites`) lands in the public MST.

The canonical reference is
[atproto#3363, "Private, non-shared data in repo?"](https://github.com/bluesky-social/atproto/discussions/3363),
where a developer asked exactly this and maintainer **bnewbold** answered with a _planned_
architecture. The [Private Data Working Group notes](https://notes.commonscomputer.com/s/atproto-private-data-wg)
record the Bluesky team in Feb 2025 saying private data was **"at least a year off."** That estimate
has held.

**So: your instinct is correct, and it isn't a compromise. It's what everyone does — including Bluesky.**

---

## 2. What Bluesky itself does — the strongest evidence available

Every one of Bluesky's own private features keeps data **out of the repo, in a server-side store
behind authenticated XRPC**:

| Feature                                                                | Where it lives                                                                                                                                                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bookmarks** (shipped private, Sept 2025)                             | `app.bsky.bookmark.getBookmarks` / `createBookmark` / `deleteBookmark` — **XRPC procedures, not record types.** _"Gets views of records bookmarked by the authenticated user. Requires authentication."_ |
| **Preferences** (muted words, saved feeds, content labels, birth date) | `app.bsky.actor.getPreferences` — _"private preferences attached to the current account"_, auth-required, PDS-stored, **not a repo record, not on the firehose**                                         |
| **DMs**                                                                | A **separate service**, `api.bsky.chat`, with its own permission set. Not repo records, **not E2EE** — Bluesky can read them.                                                                            |

The bookmarks case is _precisely_ Buttery's "saved/favorited recipe" problem. The
[design discussion (#2000)](https://github.com/bluesky-social/atproto/discussions/2000) shows them
wrestling with your exact question — _"bookmarks are probably expected to be private… but can
`com.atproto.repo` records even be private?"_ — and landing on: no, so we do it server-side.

⚠️ **Do not stuff Buttery data into a user's Bluesky preferences blob.** It's technically reachable,
but it's a shared mutable bag other clients rewrite, it's schema-validated against Bluesky's union,
and you'd be squatting in another app's namespace. There is no generic `com.atproto.*` equivalent a
third-party app can claim.

[Issue #1405](https://github.com/bluesky-social/atproto/issues/1405) asks for **private annotations
on public records** — your "private notes on a recipe" feature, exactly. It was converted to a
discussion and never resolved. No mechanism exists.

### What other atproto apps do

- **Tangled** (git) — the cleanest published example of the split: `sh.tangled.*` public records for
  identity, repo announcements, and social graph; **knots** (self-hostable git servers) hold the
  actual git data **and own access control** — _"a knot itself owns its members and per-repo
  collaborators directly."_ The appview is _"only a glorified edge index."_
- **Grain** — the naming convention worth stealing: **underscore-prefixed tables**
  (`_mutes`, `_preferences`, `_oauth_*`, `_cursor`) are AppView-local and never written to a PDS;
  public equivalents are records. Instantly legible in a schema review.
- **Bookhive** — the "hive" split: canonical shared catalog (`hive_book`) lives **only in the app
  DB**; the PDS record carries a `hiveId` pointer plus the user's own opinion.
- **Smoke Signal** — ["source-based hydration"](https://blog.smokesignal.events/posts/3lvehxge7oo2a-atprotocol-record-hydration-building-privacy-aware-views):
  coarse data in the public record, an authenticated inter-service call for the private remainder.
- **Germ** — the one shipping real E2EE, and its shape proves the point: exactly **one** public
  record, `com.germnetwork.keypackage` (an MLS keyPackage + anchor key). _All_ private content lives
  on Germ's own infrastructure. The repo holds a key-discovery breadcrumb, nothing else.
- **Statusphere** (official tutorial) — `account` table keyed by DID, `status` table keyed by
  `at://` URI. The tutorial is explicit that the app DB is a **cache**, with user repos authoritative.

**Net: no shipped atproto app puts private data in a user's repo, because it can't.**

---

## 3. What's coming: Permissioned Data / "spaces"

Primary sources: [proposals PR #94 (dholms, opened 2026-06-23, still draft)](https://github.com/bluesky-social/proposals/pull/94)
and the [Permissioned Data Diary series](https://dholms.leaflet.pub/), Diaries 1–7 running
2026-02-11 → **2026-07-17**.

Verified mechanics:

- The unit is a **space**, identified by (space authority DID, space type NSID, space key). **One
  permissioned repo per (user, space)** — not one per user. A space is simultaneously the
  authorization boundary and the sync boundary.
- New URI scheme **`ats://`** (deliberately not `at://`):
  `ats://{spaceDid}/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}`
- Two-token flow: the user's PDS mints a single-use ~60 s **delegation token**; the space authority
  exchanges it for a multi-use ~2 h **space credential**. Optional **client attestations** let a
  space gate by _which app_ is asking.
- Commits use **LtHash** (incremental lattice set hash) rather than an MST, and signatures are
  **deniable** — the server signs random per-commit bytes and binds the digest via HMAC, so a leaked
  commit isn't a rebroadcastable proof of content.
- Every PDS must implement a baseline **`com.atproto.simplespace`** anchored on the user's own DID,
  with policy modes `member-list` (default) / `public` / `managing-app`, and app access control
  `#open` or `#allowList`.
- New OAuth scope grammar: `space:<spaceType>[?authority=…][&skey=…][&collection=…][&action=…][&manage=…]`

**The design explicitly names "personal data (bookmarks, mutes, drafts)" and "collective structures
(private forums, group chats)" as target use cases.** A Buttery household is squarely a space; so is
a user's private saved-recipe list (single-member, via `simplespace`).

**Status, honestly:** draft PR, _"details, terminology, and behaviors are all likely to change"_,
_"very rough sketches of an implementation on a public branch."_ The
[Spring 2026 roadmap](https://atproto.com/blog/2026-spring-roadmap) calls it _"early design phase"_
and a major focus through the summer, requiring changes across PDS implementations, SDKs, specs, and
moderation tooling. Blacksky, Northsky, and Habitat are doing parallel implementations.
**Not shippable for a third-party app in 2026. Plan for 2027 at the earliest.**

### Encryption is explicitly off the table (for the protocol)

[Diary 1, "To Encrypt or Not to Encrypt"](https://dholms.leaflet.pub/3meluqcwky22a) is the decision
record: atproto will **not** design E2EE for permissioned data. Reasons: different threat model
(access control ≠ confidentiality); servers need to see data for search, notifications, moderation,
recommendations; key management cascades to every client dev; MLS caps around 2–10k members while
spaces need millions.

> _"Permissioned data is about access and data flow… E2EE is about cryptographic confidentiality."_

Apps may layer E2EE themselves.

### Known critiques worth internalizing

- [dthompson](https://toot.cat/@dthompson/116297222070589790): the ACL model is too weak — _"a single
  space owner, no means of delegation, and the granularity of permissions is only read/write"_ — so
  _"each app will have to layer on its own additional app-specific access control."_ **Even
  post-spaces, Buttery will still do app-level authorization.**
- [Luke Kanies (2026-07-20)](https://lukekanies.com/writing/building-on-atproto/): the public/private
  split is artificial, and converting a private item to public requires delete-and-recreate, losing
  identity and engagement metadata. **A "make this private recipe public" flow will be lossy.**
- [Diary 6](https://dholms.leaflet.pub/3mndhk7ihsc2g) argues _against_ one universal community
  container: model a community as **multiple typed spaces under one authority DID**, because _"read
  access to a space means access to everything"_ and a generic consent screen is illegible.
  **Take this design lesson now.**

---

## 4. The recommended architecture

```
┌─ user's PDS (public, portable, interoperable) ─────────────────┐
│  exchange.recipe.recipe      the recipe itself                 │
│  exchange.recipe.collection  public cookbooks (interop surface) │
│  exchange.recipe.profile     public cook profile                │
└────────────────────────────────────────────────────────────────┘
                    ▲ write via OAuth        │ index via Tap/cron
                    │                        ▼
┌─ Buttery Postgres ─────────────────────────────────────────────┐
│  PUBLIC MIRROR (rebuildable cache, keyed did+collection+rkey)   │
│  ─────────────────────────────────────────────────────────────  │
│  APP-CANONICAL (Buttery owns; the "hive" pattern)               │
│    ingredient catalog, parsed quantity/unit, nutrition rollups  │
│  ─────────────────────────────────────────────────────────────  │
│  PRIVATE (Buttery-owned, never leaves)                          │
│    _household, _household_member, _household_invite             │
│    _saved_recipe, _recipe_note, _plan_entry, _shopping_item     │
└────────────────────────────────────────────────────────────────┘
```

### Key on DID, always

Handles are DNS names and change freely. DIDs never change and survive PDS migration.

```
did text primary key
handle text                       -- denormalized cache
handle_resolved_at timestamptz
```

The payoff shows up immediately in the household case: **if a household member migrates PDS, their
DID is unchanged, so their membership, meal plans, and notes just keep working.** Nothing to do.

### Account lifecycle → private data

| Event                       | Action on private data                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `deactivated` / `suspended` | Stop serving. **Retain.** Show "account unavailable", not 404.                                                |
| `takendown`                 | Same — long-term but reversible.                                                                              |
| `deleted`                   | Stop serving immediately (gone, not never-existed). Defer purge to a background job on your retention policy. |
| PDS migration               | **Nothing.** DID unchanged.                                                                                   |

**The hard case atproto gives you no guidance on:** a household member deletes their account. Do the
shopping lists they created vanish for the other four people? **Decide and document it.**
Recommendation `[inferred]`: soft-delete the member, retain shared artifacts attributed to a
tombstoned DID, hard-delete their _personal_ (non-shared) notes.

### Referencing public records from private rows: store all three

```sql
create table _saved_recipe (
  household_id  uuid not null,
  saved_by_did  text not null,
  uri           text not null,     -- always resolves to current version
  cid           text not null,     -- pins the version they saved
  title_snapshot      text,        -- renders when source is deleted / PDS is down
  ingredients_snapshot jsonb,      -- shopping list must work offline of the source
  snapshot_at   timestamptz not null,
  primary key (household_id, uri)
);
```

- **URI alone** — always current, but you can't detect edits and you break on delete.
- **URI + CID** — content-addressed pin. Lets you show _"this recipe changed since you saved it"_,
  which is a real feature for a recipe app: someone's meal plan shouldn't silently change its
  ingredient list under them.
- **Denormalized snapshot** — the meal plan and shopping list still render when the source is
  deleted, the author's PDS is down, or the record moved. **Recipe deletion is not hypothetical.** A
  shopping list that 500s because a stranger unpublished a recipe is a bad product.

Do all three. Snapshot enough to render a card and compute a shopping list. Show "saved version /
view current" when CIDs diverge.

### Households

There is **no atproto primitive for private groups today.**
([The Arbiter](https://zicklag.leaflet.pub/3mjrvb5pul224) is an early proposal for a standardized
group-management service filling the gap PR #94 leaves — worth watching, not depending on.)

```sql
create table _household (id uuid primary key, name text, created_by_did text, created_at timestamptz);
create table _household_member (
  household_id uuid, did text, role text,     -- owner | adult | member | viewer
  joined_at timestamptz, invited_by_did text,
  primary key (household_id, did)
);
create table _household_invite (
  token_hash text primary key,                -- store the HASH, not the token
  household_id uuid, role text, created_by_did text,
  expires_at timestamptz, max_uses int, uses int, accepted_by_did text,
  bound_to_did text                           -- optional: direct invite to a specific DID
);
```

**One authorization chokepoint.** Every read and write of household-scoped data goes through
`assertMember(did, householdId, minRole)`, called in your TanStack Start **server functions, never in
the client**. With Kysely, consider a query-builder wrapper that makes it hard to write a
household-scoped query without the membership join.

**Split by future space-type, per Diary 6.** Don't build one monolithic `_household_data` blob.
Household notes, meal plans, shopping lists, and saves are **distinct resource families with distinct
authorization**. That maps 1:1 onto future spaces, and it's better design regardless.

### Be honest in the UI

> _"Your recipes live on your atproto account and are yours. Your households, saved lists, meal
> plans, and private notes are stored by Buttery in Buttery's database — atproto doesn't yet have a
> way to store private data on your own account. When it does, we intend to move them there."_

**Ship a JSON export endpoint from day one** covering every private table, with `at://` URIs + CIDs
intact so the export is re-importable. That export is simultaneously your trust story, your GDPR
answer, and your migration test harness.

---

## 5. Middle paths — assessed and rejected

### "Unlisted" records

Do not exist. No visibility field in the repo spec; `listRecords` enumerates any collection in any
repo without auth.

### App-specific collection other apps ignore (`pub.buttery.householdNote`)

**This is not private.** Anyone can `listRecords` your collection on any repo; the firehose
broadcasts every write; Jetstream consumers and repo archives will index it within seconds of Buttery
getting any attention.

Worse, it's **deceptively** not private. Users will read "Buttery says this is my household's data"
as "nobody else can see it." Do not do this for anything a user would be upset to find on the public
web. It's fine for genuinely-public-but-app-specific data (e.g. structured ingredient extensions).

### Encrypt the payload, hold keys server-side

Technically workable. Honest assessment:

- (a) You gain essentially nothing over Postgres — Buttery still holds the keys and is still the
  trust anchor.
- (b) You **lose** query, index, and aggregate. No pantry search, no shopping-list rollup, without
  decrypting everything.
- (c) You leak metadata anyway — record existence, count, timestamps, rkeys, edit frequency all go
  out on the firehose. For a household that's a **visible activity graph**.
- (d) Ciphertext in a public repo is permanent and harvestable. Any future key compromise or crypto
  break is retroactive across everything ever written.
- (e) You pollute other people's repos with garbage they can't inspect, which the ecosystem will
  rightly resent.
- (f) Lose the keys and the user has unreadable junk in their permanent repo.

**Verdict: strictly worse than Postgres.** Real client-held-key E2EE (Germ's model) is defensible but
is a large project and is _wrong_ for household data that must be server-computable (meal plan →
shopping list aggregation).

### Blob signed-URLs / metadata broadcast

Nick Gerakines' access-controlled-blobs-via-signed-URLs and David Nash's metadata-broadcast ideas are
listed in the [Private Data WG](https://atproto.wiki/en/working-groups/private-data). Both proposals,
neither implemented. Also: microcosm has an early `pocket` crate — _"a personal-private atproto data
service authorized by PDS service proxying / `getServiceAuth`"_ — directly relevant to Buttery's
private collections. **Watch it, don't depend on it.**

---

## 6. Future-proofing checklist

**Makes the eventual migration easy:**

1. **DID as the only user key**, everywhere, no handle joins.
2. **Model private rows record-shaped now.** Each gets a stable TID-shaped id, a collection-shaped
   type name you'd be happy to register (`<authority>.household.note`, `<authority>.plan.entry`), a
   `createdAt`, and a JSON `value` column **alongside** your typed columns. Then "migrate to spaces"
   is: emit the value, write it to a permissioned repo, keep your DB as an index.
3. **Write real Lexicon schemas for your private types today**, even unused. They're your migration
   contract and they force the data to stay legible.
4. **Separate by future space-type** (Diary 6), not one blob.
5. **One authorization chokepoint** so swapping "Buttery decides" → "space credential decides" is one
   module.
6. **Store `at://` + CID on every reference.** Spaces reference public records the same way.
7. **Ship the export path early** — it doubles as the migration exporter.
8. **Give households a stable opaque ID now**, and consider that a future household may itself be a
   DID.

**Makes it hard:** handle-keyed rows; private state entangled with Buttery-only concepts that have no
atproto analog (internal user IDs, Stripe customer IDs mixed into household rows); heavy derived
state with no source-of-truth record behind it; treating a household as a Buttery row rather than an
addressable entity; and any use of the security-by-obscurity public-collection trick, which produces
public data you then have to apologize for and can never fully retract.

---

## Sources

[atproto#3363 private non-shared data](https://github.com/bluesky-social/atproto/discussions/3363) ·
[Private Data WG notes](https://notes.commonscomputer.com/s/atproto-private-data-wg) ·
[atproto.wiki private-data WG](https://atproto.wiki/en/working-groups/private-data) ·
[Proposals PR #94](https://github.com/bluesky-social/proposals/pull/94) ·
[Permissioned Data Diaries](https://dholms.leaflet.pub/) ·
[Diary 1 — To Encrypt or Not](https://dholms.leaflet.pub/3meluqcwky22a) ·
[Diary 6 — Modeling communities](https://dholms.leaflet.pub/3mndhk7ihsc2g) ·
[Spring 2026 roadmap](https://atproto.com/blog/2026-spring-roadmap) ·
[Bookmarks API](https://docs.bsky.app/docs/api/app-bsky-bookmark-get-bookmarks) ·
[getPreferences](https://docs.bsky.app/docs/api/app-bsky-actor-get-preferences) ·
[Bookmarks design discussion #2000](https://github.com/bluesky-social/atproto/discussions/2000) ·
[atproto#1405 private annotations](https://github.com/bluesky-social/atproto/issues/1405) ·
[Tangled docs](https://docs.tangled.org/single-page) ·
[Smoke Signal — privacy-aware views](https://blog.smokesignal.events/posts/3lvehxge7oo2a-atprotocol-record-hydration-building-privacy-aware-views) ·
[Germ × atproto](https://www.germnetwork.com/blog/integrating-germ-atproto) ·
[The Arbiter](https://zicklag.leaflet.pub/3mjrvb5pul224) ·
[Luke Kanies — building on atproto](https://lukekanies.com/writing/building-on-atproto/) ·
[Statusphere tutorial](https://atproto.com/guides/statusphere-tutorial)
