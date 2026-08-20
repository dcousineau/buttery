# Results: Collections

Execution log for the plan at [`../2026-08-20-collections.md`](../2026-08-20-collections.md).
Built on `feat/collections`, one milestone at a time (plan §10), each independently
verified before the next. This document records **what was actually built**, the deliberate
deviations with their reasons, the commands run, and what the next milestone's implementer
needs to know.

---

## Milestone 1 — schema + server core + port layer

Inert by design: no UI reaches any of it yet. Everything below is local — no PDS write
exists in this milestone.

### What was built

**Migration** — `services/web/src/db/migrations/1787267048095_create_recipe_collection_tables.ts`
(scaffolded with `db:migrate:new`, never hand-named).

- `recipe_collection` — id/household/name/description/position/created_by_did/timestamps,
  plus the seven publish columns and `record_stale`. Three CHECKs:
  `recipe_collection_name_check` (1–100 chars), `recipe_collection_description_check`
  (≤ 1000 chars), and `recipe_collection_publish_shape_check`
  (`num_nonnulls(published_by_did, rkey, uri, cid, rev, published_at, record_created_at) in (0, 7)`
  — the all-or-none shape). No unique name, on purpose (§8).
- `recipe_collection_entry` — PK `(collection_id, recipe_id)`, FK `collection_id` →
  `recipe_collection` CASCADE, and the composite FK
  `(household_id, recipe_id)` → `household_recipe` CASCADE (the `household_recipe_note`
  trick).
- Indexes: `(household_id, position)` on the parent, `(collection_id, position)` on
  entries, plus **one index the plan did not list** — `(household_id, recipe_id)` on
  entries. See deviation 4.
- `down()` was exercised (`db:migrate:down` then `db:migrate:up`) and is clean.

`src/db/types.ts` was regenerated with `db:codegen`, never hand-edited.

**Server** — `services/web/src/server/collections.ts` (new).

Every fn is the house shape: a thin `createServerFn` wrapper (session → `assertMember` →
body) plus an exported session-free body taking `(db, did, householdId, input)` so
`collections.db.test.ts` can drive it. All server-only imports are dynamic `import()`
inside the handler.

| server fn                    | body                         | notes                                               |
| ---------------------------- | ---------------------------- | --------------------------------------------------- |
| `listCollections`            | `readCollections`            | the single read; `householdScopedQuery` is the gate |
| `createCollection`           | `insertCollection`           | appends at bottom, returns the new summary          |
| `updateCollection`           | `patchCollection`            | name and/or description, bumps `updated_at`         |
| `reorderCollections`         | `orderCollections`           | local-only, never re-puts                           |
| `reorderCollectionRecipes`   | `orderCollectionRecipes`     | IS the published array order                        |
| `addRecipesToCollection`     | `fileRecipesIntoCollection`  | preflight → `recipes_unpublished`                   |
| `removeRecipeFromCollection` | `unfileRecipeFromCollection` | delete + renumber, idempotent                       |
| `deleteCollection`           | `removeCollection`           | **owner-only**, local-only in M1                    |

Both orderings use the meal-plan §3.6 pattern verbatim: `FOR UPDATE` on the whole parent
scope (`lockCollections` / `lockEntries`), then a dense `0..n-1` rewrite
(`renumberCollections` / `renumberEntries`). A shared `reconcileOrder` reconciles the
client's snapshot against what is actually there — requested order first, unknown ids
dropped, unmentioned rows appended in their existing order — so a concurrent create never
turns a drag into an error.

Two helpers exist for the box-removal hook: `collectionsHoldingRecipe` (sorted, which is
also the lock order) and `renumberAfterUnfile`.

**Change to existing code** — `services/web/src/server/household-recipes.ts`:

- `resolveAdderHandles` is now **exported** (§5 asked for this rather than a duplicate).
- `removeRecipeFromHousehold` gained a body, `unboxRecipe(db, householdId, recipeId)`,
  which runs one transaction: collect the affected collection ids → delete the
  `household_recipe` row (the composite FK cascades the entries) → renumber each affected
  collection densely. It returns `{ unfiledFrom }` — the sorted list M5 re-puts.

**Port layer**

- `src/lib/api/types.ts` — `CollectionSummary` DTO, exactly the §6 shape. No
  `CACHE_SCHEMA_VERSION` bump: no existing DTO changed.
- `src/lib/api/keys.ts` — `keys.household.collections(hid)`.
- `src/lib/api/queries.ts` — `householdCollectionsQuery(householdId)` (offline-readable,
  as intended).
- `src/lib/api/transport.ts` — seven wrappers in natural-args style, plus a re-export of
  the `AddRecipesToCollectionResult` type. No publish/unpublish (M5).
- `src/lib/api/mutations.ts` — five `mutationKeys` and five `optimisticOver` factories:
  `updateCollectionMutation`, `reorderCollectionsMutation`,
  `reorderCollectionRecipesMutation`, `addRecipesToCollectionMutation`,
  `removeRecipeFromCollectionMutation`. Create/publish/unpublish/delete stay
  non-optimistic, per §6.
- `src/components/collections/optimistic.ts` — the pure patch fns
  (`withCollectionEdited`, `withCollectionsReordered`, `withCollectionRecipesReordered`,
  `withRecipesFiled`, `withRecipeUnfiled`, `withRecipeUnfiledEverywhere`).

**Tests**

- `src/server/collections.db.test.ts` — 38 tests: CHECK constraints (including the
  half-published rejection and the composite-FK refusal of an unboxed recipe), dense
  positions after create/reorder/file/unfile/delete on **both** tables, density under
  interleaved concurrent reorders, the box-removal cascade + renumber (and that another
  household's filing of the same recipe survives), the `recipes_unpublished` preflight,
  cross-household inertness of every write, and the `assertMember` role gate.
- `src/components/collections/optimistic.test.ts` — 20 tests, one group per patch fn.
- `src/server/collections.test.ts` — 10 validator tests for the length limits.

### Deviations from the spec, and why

1. **`listCollections` takes no `householdId` argument** (§5 writes it as
   `listCollections({ householdId })`). Every household-scoped server fn in this codebase
   derives the household from `session.active_household_id` and never accepts it as an
   argument — offline plan §2.4, restated at the top of `transport.ts` ("`householdId`
   appears in no signature below"). The id lives in the query key only, which is exactly
   what §6's `householdCollectionsQuery(householdId)` does. Accepting it would have made
   collections the one resource where a client argument reached an authorization decision.

2. **`addRecipesToCollection` has no `publishRecipeIds` parameter yet.** The "Publish
   recipe & add" combo is a milestone 5 deliverable (§10.5), and an accepted-but-ignored
   parameter would have been a silent lie — the preflight would still refuse. The preflight
   itself IS implemented and fails closed; the exact spot the combo attaches to carries a
   `TODO(m5)`. M5 adds the field to the validator, the transport wrapper and the mutation.

3. **Length validators count UTF-8 bytes, and enforce no grapheme cap.** §1 says "enforce
   100 bytes / 64 graphemes like the PDS will", but the vendored lexicon
   (`exchange.recipe.collection.json`) carries **only** `maxLength` on `name` and `text` —
   there is no `maxGraphemes` on either field. atproto counts `maxLength` in UTF-8 bytes,
   so `collectionName` / `collectionDescription` measure bytes after trimming. Adding a
   64-grapheme cap would have rejected names the PDS accepts. The DB CHECKs use
   `char_length` exactly as §3 specifies; the zod validators are the tighter, authoritative
   gate.

4. **One extra index**: `recipe_collection_entry (household_id, recipe_id)`. The PK leads
   with `collection_id`, so "which collections hold this recipe?" — the chips query, and
   the sweep `removeRecipeFromHousehold` runs on every box removal — would otherwise be a
   sequential scan. Two lines, and it is on the hot path of an existing feature.

5. **`recipe_collection_entry.household_id` is not structurally tied to its collection's
   household.** The plan's constraint list has no FK for it and adding one would need a
   redundant unique index on `recipe_collection (id, household_id)`; instead every write
   derives `household_id` from the collection row it just read _under the household scope_,
   and the db suite asserts every write is inert against another household's collection id.
   Flagging it as a known app-level (not structural) invariant.

6. **`withRecipeUnfiledEverywhere` exists but is not yet wired to a mutation.** It is the
   client half of decision §2.11 and is unit-tested; the remove-from-box flow is not a
   `mutationOptions` factory today (`DetailPane` calls the transport directly), so M2 wires
   it when it touches that path.

7. **The §9 case "delete-with-PDS-failure keeps local rows" is not in the db suite.** There
   is no PDS path in M1 — `deleteCollection` is local-only. It belongs to M5, and the db
   test file says so in its header.

### Commands run

```
pnpm --filter @buttery/web db:migrate:new create_recipe_collection_tables
pnpm --filter @buttery/web db:migrate:up
pnpm --filter @buttery/web db:codegen
pnpm --filter @buttery/web db:migrate:down && pnpm --filter @buttery/web db:migrate:up   # down() sanity check
pnpm --filter @buttery/lexicons build
pnpm typecheck
pnpm lint
pnpm format:check                      # 6 files reformatted with `pnpm exec oxfmt <files>`, then clean
pnpm test
DATABASE_URL=<services/web/.env> pnpm --filter @buttery/web exec vitest run --project db
```

`pnpm test:db` was **not** used: it wraps `railway run`, and this environment has no
Railway login. The db project was run directly with `DATABASE_URL` taken from
`services/web/.env` — same suite, same database.

### Test results

| command                              | result                                                        |
| ------------------------------------ | ------------------------------------------------------------- |
| `pnpm typecheck`                     | **pass** — all 7 workspace projects                           |
| `pnpm lint` (oxlint)                 | **pass**, exit 0 — 3 pre-existing warnings in unrelated files |
| `pnpm format:check` (oxfmt)          | **pass** — "All matched files use the correct format"         |
| `pnpm test`                          | **pass** — web: 34 files, 548 passed / 217 skipped (no DB)    |
| `vitest run --project db`            | **pass** — 8 files, **217 passed**, 0 failed                  |
| └ `collections.db.test.ts` alone     | **pass** — 38/38                                              |
| └ `optimistic.test.ts`               | **pass** — 20/20                                              |
| └ `collections.test.ts` (validators) | **pass** — 10/10                                              |

### Notes for the next milestone's implementer

**Milestone 2 (desktop UI).**

- The two cached reads you need are `householdRecipesQuery(hid)` and
  `householdCollectionsQuery(hid)`. `CollectionSummary.recipeIds` is already in entry
  order, so the `c=<id>` scope is `recipeIds.map(id => rowsById.get(id))` — no sort.
- The five optimistic mutations are wired and ready. Create and delete are **not**: call
  `api.createCollection` / `api.deleteCollection` and invalidate
  `keys.household.collections(hid)` yourself.
- `createCollection` returns the full `CollectionSummary`, so quick-add can select the new
  collection without waiting for the invalidation to land.
- `addRecipesToCollection` resolves — it does not throw — with
  `{ ok: false, reason: "recipes_unpublished", recipeIds }`. Because it resolves, the
  optimistic patch is **not** rolled back by `onError`; the `onSettled` invalidation
  corrects the list. Render the blocked rows from `recipeIds`.
- `?c=` pointing at a deleted collection is simply an id absent from the array — render the
  inline empty state, never a 404.
- Delete is owner-only server-side (`InsufficientRoleError`); hide the affordance for
  members rather than letting them discover it by failure.

**Milestone 5 (atproto publish).** Five `TODO(m5)` markers are already at the exact call
sites `reputOrMarkStale` attaches to:

- `patchCollection` (name/description changed)
- `orderCollectionRecipes` (the array order changed)
- `fileRecipesIntoCollection` (membership grew) — and, in the same fn, the spot where
  `publishRecipeIds` publishes each recipe before falling through to the filing
- `unfileRecipeFromCollection` (membership shrank)
- `unboxRecipe` in `household-recipes.ts` — it returns `{ unfiledFrom }`, the sorted
  collection ids to re-put after the commit

`removeCollection` carries a sixth `TODO(m5)` for the "PDS delete first, local delete only
on success" ordering. `reorderCollections` deliberately has none: the list order is
local-only (§2.10).

`markPublished()` in `collections.db.test.ts` fakes publish state with a raw `UPDATE`;
replace those tests' fixtures with the real `publishCollection` once it exists, and add the
§9 "delete with a failing PDS keeps the local rows" case.

---

## Milestone 5 (server) — atproto publish

The server half of §5: the owner writes that create and destroy a record on a PDS, the
re-put plumbing every other write now ends with, and the "Publish recipe & add" combo.
The atproto write layer (`src/lib/atproto/collection-writes.ts`) was already committed;
nothing in it changed. **No UI** — the milestone-5 UI pass owns that, and the contract it
needs is spelled out at the bottom of this section.

The rule the whole milestone hangs on: **the local database is the source of truth and the
record is a projection of it.** So:

- A PDS failure **after** a local write is an annotation (`record_stale`), never a rollback
  and never an exception. A save the user watched succeed does not un-happen because
  someone's PDS was unreachable.
- A PDS failure **before** a destructive local write (unpublish, delete) aborts the whole
  thing. The rkey and the publisher's DID live in the rows those writes destroy, so
  deleting locally first and failing on the PDS would strand a live record with nothing
  left that knows how to remove it.

### What was built

**`src/server/collections.ts`** — new exports (every server fn is the house shape: a thin
wrapper doing session → `assertMember` → body, plus an exported session-free body the db
suite drives directly).

| server fn (owner-only ★) | body                     | result                                                             |
| ------------------------ | ------------------------ | ------------------------------------------------------------------ |
| `publishCollection` ★    | `runPublishCollection`   | `PublishCollectionResult`                                          |
| `unpublishCollection` ★  | `runUnpublishCollection` | `UnpublishCollectionResult`                                        |
| `deleteCollection` ★     | `removeCollection`       | `DeleteCollectionResult` (**was** `{ deleted }` — see deviation 1) |
| `retryCollectionSync`    | `retrySync`              | `{ stale: boolean }`                                               |
| —                        | `reputOrMarkStale`       | `{ stale: boolean }` — never throws                                |
| —                        | `reputEach`              | `string[]` — the ids that came back stale                          |

`publishCollection` runs in the order role gate → kill switch (`isAtprotoPublishEnabled`,
fail-closed) → `recipes_unpublished` preflight → `createCollectionRecord` → stamp the row.
The PDS write is last because everything before it is free to refuse, and a refusal must
cost nothing. The stamp is a compare-and-swap (`where published_by_did is null`); if it
loses the race the just-created record is deleted back off the PDS rather than left
orphaned, and the caller gets a thrown error (a genuine two-owners-at-once race).

`unpublishCollection` deletes as `published_by_did` — not as the acting owner (§2.5) — then
clears all seven publish columns plus `record_stale` in one statement, keeping every local
row. `deleteCollection` does the same PDS delete first and only then takes the local rows
and renumbers.

**Where `reputOrMarkStale` is called from** — all six of milestone 1's `TODO(m5)` markers
are gone, five of them replaced by a call:

1. `patchCollection` — after the `UPDATE` commits (name and description are published fields).
2. `orderCollectionRecipes` — after the transaction (entry order IS the published array order).
3. `fileRecipesIntoCollection` — after the transaction, only when something was actually added.
4. `unfileRecipeFromCollection` — after the transaction, only when something was removed.
5. `unboxRecipe` (`src/server/household-recipes.ts`) — after the transaction commits, via
   `reputEach(db, unfiledFrom)` (decision §2.11).
6. `removeCollection` — the sixth marker was the PDS-**delete**-first ordering, not a re-put.

`reorderCollections` still has none: the household list order is local-only (§2.10), and a
db test now asserts it never touches a PDS.

Each of those writes returns `stale` alongside its existing field
(`{ updated, stale }`, `{ reordered, stale }`, `{ ok: true, added, stale }`,
`{ removed, stale }`); `unboxRecipe` returns `{ unfiledFrom, staleCollectionIds }`.

**"Publish recipe & add"** — `addRecipesToCollection` gained `publishRecipeIds?: string[]`.
Consent is per-id and never inferred: unpublished ids that are _not_ on that list still fail
the whole call with `recipes_unpublished` carrying exactly those ids. The consented ones are
published first, sequentially, through the existing `publishRecipe` server fn, and the call
then falls through to the ordinary filing. The recipe path's refusals are mapped onto this
call's union — `publish_disabled` → `flag_disabled`, `reauth_required` → `scope_error`, and
anything else (invalid, duplicate) → `recipes_unpublished` for the one id that failed, which
is exactly what is true of it.

**Transport** (`src/lib/api/transport.ts`) — `publishCollection`, `unpublishCollection`,
`retryCollectionSync` added; `addRecipesToCollection` takes `publishRecipeIds`;
`updateCollection` / `reorderCollectionRecipes` / `removeRecipeFromCollection` /
`deleteCollection` carry the widened results; the three new result unions are re-exported
beside `AddRecipesToCollectionResult`. **`src/lib/api/types.ts` is unchanged** — the M1 DTO
already carries `recordStale`, `publishedByDid`, `publishedByHandle`, `publishedAt` and
`uri`, so there was no field to add and still no `CACHE_SCHEMA_VERSION` bump.
No optimistic patches: publish/unpublish/delete are non-optimistic per §6.

**Tests** — `src/server/collections.db.test.ts` grew from 38 to **74** tests. The suite now
fakes exactly one thing: the three network functions in `collection-writes.ts`
(`buildCollectionRecord` stays real, so the spies receive the records a PDS would have).
Publish state is created by the real `runPublishCollection` — milestone 1's hand-written
`UPDATE` fixture is gone, as its note asked. New coverage: every publish outcome (column
stamping incl. the PDS-minted rkey, refs in position order, empty collection omitting
`recipes`, `recipes_unpublished`, cid-less recipe counted unpublished, `flag_disabled`,
idempotence, `scope_error`, `publisher_unavailable`, cross-household inertness); the re-put
on all four write paths plus the frozen `createdAt` and the CAS cid; `record_stale` set on
failure with the local write still committed, and cleared by the next success; the box-removal
sweep re-putting only the published collections; `retryCollectionSync`; unpublish clearing
all seven columns and keeping them on failure; **§9's "delete with a failing PDS keeps the
local rows"**; and the whole publish-and-add combo including each mapped refusal.

### Deviations from §5, and why

1. **`deleteCollection` returns a union, not `{ deleted: boolean }`.** §5 specifies the
   PDS-first ordering but not what a PDS refusal looks like to a caller. Throwing would have
   made "your PDS is unreachable, nothing was deleted, try again" indistinguishable from a
   bug, so it returns `DeleteCollectionResult` = `{ ok: true; deleted } | CollectionPdsFailure`,
   the same shape as its two siblings. Nothing in the UI called it yet when this landed.

2. **The PDS-failure union has two arms, not more.** §5 names `publisher_unavailable`;
   `scope_error` is split out of it because it is the one failure the acting user can fix
   (re-authorize), exactly as the recipe path splits `reauth_required` out. Everything else
   — session unrestorable, PDS down, network gone, CAS lost twice — collapses into
   `publisher_unavailable`, because from a caller's seat they have identical consequences
   (nothing changed, try later) and finer reasons would only invent UI copy nobody can act
   on differently. `publisher_unavailable` carries the publisher's `@handle`, since the
   acting member may not be the publisher (§2.5).

3. **Every write that can re-put now returns `stale`.** §5 says callers surface `stale: true`
   as "Saved — couldn't update @handle's published copy yet", which is only possible if the
   flag travels with the write's own answer. Additive: `{ updated }` → `{ updated, stale }`,
   and so on. `unboxRecipe` returns `staleCollectionIds` (a subset of `unfiledFrom`) rather
   than a boolean, because it can touch several collections at once.

4. **"Published" means public **with both halves of the strongRef**.** The preflight now
   also refuses a recipe with a `uri` but no `cid` (M1 checked `visibility`/`uri` only). A
   lexicon `strongRef` requires both, so a cid-less recipe simply cannot go in the record;
   counting it as publishable would have produced a PDS 400 instead of an answerable
   `recipes_unpublished`. The db fixture's published recipes gained cids to match.

5. **`fileRecipesIntoCollection` takes an optional `RecipePublisher`.** The default is the
   real `publishRecipe` server fn and every caller in the app uses it. It is a parameter
   only because the recipe publish path resolves its own session and the db suite has none,
   so there is no other way to exercise the combo against a real database.

6. **`publishCollection` throws (rather than returning a variant) for a collection that is
   not this household's, or that lost the publish race.** Both are "this id does not name a
   thing you can publish", not a decision a user can make — the same call `fileRecipesInto
Collection` already makes for an unknown collection.

7. **The kill switch gates publish only.** §5 attaches `isAtprotoPublishEnabled` to
   `publishCollection`, and unpublish/delete deliberately do not consult it: the switch stops
   _new_ records reaching the atmosphere, and turning it off must never trap a record that is
   already there.

### Commands run

```
pnpm --filter @buttery/lexicons build
pnpm typecheck
pnpm lint
pnpm format:check                      # 2 files reformatted with `pnpm exec oxfmt <files>`, then clean
pnpm test
DATABASE_URL=<services/web/.env> pnpm --filter @buttery/web exec vitest run --project db
```

`pnpm test:db` was again not usable (it wraps `railway run`, and this environment has no
Railway login); the db project ran directly with `DATABASE_URL` from `services/web/.env`.

### Test results

| command                          | result                                                             |
| -------------------------------- | ------------------------------------------------------------------ |
| `pnpm typecheck`                 | **pass** — all 7 workspace projects                                |
| `pnpm lint` (oxlint)             | **pass**, exit 0 — 3 pre-existing warnings in unrelated components |
| `pnpm format:check` (oxfmt)      | **pass** — "All matched files use the correct format"              |
| `pnpm test`                      | **pass** — web: 35 files, 564 passed / 253 skipped (no DB)         |
| `vitest run --project db`        | **pass** — 8 files, **253 passed**, 0 failed                       |
| └ `collections.db.test.ts` alone | **pass** — **74/74** (was 38)                                      |

### What the milestone-5 UI pass needs to know

**The unions to handle.** All of these _resolve_ — none of them throws — so `onError` never
fires and there is nothing to roll back (publish/unpublish/delete are non-optimistic; just
invalidate `keys.household.collections(hid)` either way).

- `publishCollection(id)` → `{ ok: true, uri, publishedByDid, publishedByHandle }` ·
  `{ ok: false, reason: "flag_disabled" }` ·
  `{ ok: false, reason: "recipes_unpublished", recipeIds }` ·
  `{ ok: false, reason: "scope_error", missingScope }` ·
  `{ ok: false, reason: "publisher_unavailable", handle }`.
  Publishing something already published is a **success**, not an error.
- `unpublishCollection(id)` → `{ ok: true, unpublished }` · `scope_error` ·
  `publisher_unavailable`. `unpublished: false` means it was not published to begin with.
- `deleteCollection(id)` → `{ ok: true, deleted }` · `scope_error` · `publisher_unavailable`.
  A failure means **nothing was deleted, locally or remotely** — the row is still there and
  the dialog should say "couldn't reach @handle's PDS; nothing was deleted", with a retry.
- `addRecipesToCollection({ collectionId, recipeIds, publishRecipeIds? })` →
  `{ ok: true, added, stale }` · `recipes_unpublished` (render the blocked rows and offer
  "Publish recipe & add", which re-calls with those ids in `publishRecipeIds`) ·
  `flag_disabled` · `scope_error` (the last two only reachable through the combo).
- `updateCollection` / `reorderCollectionRecipes` / `removeRecipeFromCollection` →
  their old field plus `stale`.

**Staleness.** Two surfaces, one meaning ("the local state is saved; the published copy is
behind"): the `stale` flag on a write's own answer, for the toast right after the edit
("Saved — couldn't update @handle's published copy yet"), and `CollectionSummary.recordStale`
from the collections read, for the persistent badge in the edit dialog. `retryCollectionSync(id)`
is the retry button: it returns `{ stale }` and is **member-level**, so do not hide it from
non-owners. Any later successful write clears the flag on its own; it never blocks an edit.

**"Publisher unavailable"** always names a person, never a machine: use the `handle` on the
variant, falling back to `CollectionSummary.publishedByHandle`, and remember the acting
member may not be the publisher (§2.5) — "we couldn't reach @sam's PDS", not "your PDS".
`scope_error` is the _acting_ user's own grant and wants the re-authorize prompt the recipe
publish flow already uses (`missingScope` is `repo:exchange.recipe.collection` in practice).

**Role.** `publishCollection`, `unpublishCollection` and `deleteCollection` are owner-only
(`InsufficientRoleError`); `retryCollectionSync` and every other write are member-level.
Hide the owner affordances rather than letting a member discover them by failure.

**The kill switch is fail-closed and off by default outside production**
(`ATPROTO_PUBLISH_ENABLED=true` in `services/web/.env` is the local escape hatch), so a dev
build will answer `flag_disabled` unless it is set. The publish confirm dialog still has to
state that the record goes to the acting owner's PDS and that every future update will come
from their handle regardless of which member edits (§2.5), and both the unpublish and delete
dialogs still have to say a PDS delete does not guarantee removal from the wider internet
(§2.7) — none of that copy exists yet.

---

## Milestone 2 — desktop UI core

The feature becomes reachable. Everything M1 built is now driven from a third column inside
`/household/recipes`, scoped by the URL. No drag and drop (M3), no mobile sheets (M4), no
publish surface (M5).

### What was built

**New — `services/web/src/components/collections/`**

| file                         | what it is                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope.ts`                   | The scope semantics of §7 as pure functions: `resolveScope`, `scopeRows`, `smartScopeRows`, `searchRows`, `smartScopeCount`, `scopeLabel`, `isDefaultScope` |
| `scope.test.ts`              | 16 unit tests over the above                                                                                                                                |
| `use-collections-column.ts`  | The collapse flag, cookie-backed (`collections_column`), collapsed by default                                                                               |
| `CollectionsTree.tsx`        | Smart rows + shelves + quick-add + the edit dialog. Reads its own queries, writes the URL                                                                   |
| `CollectionRow.tsx`          | `CollectionTreeRow` (the shared row: icon, label, count, selection paint) and `CollectionRow` (a real shelf, plus the hover gear)                           |
| `QuickAddRow.tsx`            | Inline `<form>`: Enter creates + selects, Escape discards, duplicates never error                                                                           |
| `CollectionsColumn.tsx`      | The desktop `<aside>` — `hidden md:flex`, and the ledger's `lg` hide-on-selection classes                                                                   |
| `ScopedLedgerHeader.tsx`     | Active scope name, description or count, and a clear-scope link                                                                                             |
| `EditCollectionDialog.tsx`   | Name, description, and the member list with per-row removal                                                                                                 |
| `CollectionChips.tsx`        | The memberships row on a recipe detail; every chip opens the picker                                                                                         |
| `CollectionPickerDialog.tsx` | Checkbox list of shelves for one recipe; each tick files/unfiles immediately                                                                                |

**Changed**

- `src/routes/household.recipes.tsx` — `validateSearch` (`?scope=`, `?c=`, both
  `.catch()`-guarded), the loader now primes `householdCollectionsQuery` alongside the box,
  the column is mounted ahead of the ledger, and the resolved scope is computed **once** and
  handed to both columns. Filter state stopped being a `LedgerFilters` object: scope is in
  the URL, and the search box is a plain `useState<string>`.
- `src/components/recipes/RecipeLedger.tsx` — `SortKey`, `LedgerFilters`, the sort `Select`
  and the "My recipes" lock-chip are **gone**. Added: the collections toggle in the filter
  bar (`aria-expanded` + `aria-controls`), `ScopedLedgerHeader`, scope-aware rows, two new
  empty states (`EmptyShelf`, `MissingCollection`), and `search: (prev) => prev` on every
  ledger row link so the scope rides onto the detail route.
- `src/components/recipes/DetailPane.tsx` — `CollectionChips` under the title block, and the
  "Back to the shelf" link carries the search through.
- `src/components/AppSidebar.tsx` — the `Collections` `soon` entry is deleted (§2.9).
- `src/components/ui/checkbox.tsx` — `CheckboxRow` gained a `tone` variant. See deviation 4.

### Deviations from §7, and why

1. **A pure `scope.ts` (plus its test) that §7 does not list.** §7 describes the scope
   semantics as prose spread across the ledger and the tree. Both columns need the same
   answer — the tree highlights what the ledger is showing — and two copies of that
   arithmetic would drift the first time a scope was added. It is pure, so it is also the
   only part of this milestone that could be tested at all (§9: no DOM tests), and the
   collection-scope join is exactly the code where a silently missing recipe would go
   unnoticed.

2. **Picking a scope deselects the open recipe.** A tree row is a `<Link to="/household/recipes">`,
   so it drops the `$id`. The alternative (staying on the recipe and changing only the
   search) leaves the detail pane showing a recipe that is not on the shelf you just picked,
   with nothing on screen to explain it. Deep-linking still composes in the direction §7
   actually specifies: recipe links carry the scope _out_ of the ledger.

3. **`ScopedLedgerHeader` does not render for the default scope.** §7 asks for "active scope
   name, count, clear-scope control above the ledger". On `mine` there is nothing to clear
   and the count is already in the search placeholder, so the strip would be furniture. Every
   other scope — including `missing-collection` — gets it.

4. **`CheckboxRow` gained a `tone` variant (`task` | `selection`), rather than the picker
   restating its own row.** The existing row paints _checked_ as the checklist dialect from
   BRAND.md: struck through, shadow dropped, "this is done". Membership is not done work — a
   list of the shelves a recipe is on, every one of them struck through, reads as "removed".
   `tone="selection"` takes the butter `accent` fill instead. Default is `task`, so every
   existing call site (grocery, plan) is byte-identical. This is the AGENTS rule about shared
   behaviour living in the shared `ui/` component rather than at the call site.

5. **The collapse hook lives in `components/collections/`, not `lib/hooks/`.** It is
   `useSyncExternalStore` over one cookie — the sidebar's storage idiom, but the sidebar
   never reads its cookie back, so there was nothing to reuse. It is written the way
   `use-mobile.ts` is (server snapshot = the collapsed default) so hydration renders the
   default and the real value lands on the first client render, with no mismatch and no
   `setState` in an effect. It is feature state; it moves to `lib/hooks/` the day a second
   feature wants a cookie-backed flag.

6. **The edit dialog has no delete, and the picker has no "Publish recipe & add".** Both are
   §10.5 deliverables (the delete dialog is one of M5's "all confirm dialogs"). The picker's
   _blocked row_ — published shelf, private recipe — **is** implemented and is unreachable
   today by construction; it is the row M5 hangs the combo action off.

7. **Membership is edited in one direction from the dialog (removal only).** §7 says "entries
   manage"; adding lives on the recipe, in the picker, because "which shelves does this
   recipe belong on?" is the question people have. A second recipe-picker inside the edit
   dialog would be a fourth surface answering it.

### Milestone seams left for 3, 4 and 5

- **M3 (drag and drop).** Four `TODO(m3)` markers: `CollectionTreeRow`'s `<li>` (drop target
  for `application/x-buttery-recipe`, drag source for list reorder) and its `leading` prop
  (the handle slot, already rendered ahead of the link); the ledger's list branch (handles +
  `DropLine` when collection-scoped and the search box is empty); and the edit dialog's
  member rows. The mutations are already wired in the port —
  `reorderCollectionsMutation` and `reorderCollectionRecipesMutation` need only an ordered
  id array.
- **M4 (mobile).** `CollectionsTree` takes `{ householdId, onNavigate?, className? }` and
  nothing else: it reads its own two cached queries, resolves the active scope from the URL
  itself, and owns the edit dialog. `CollectionsSheet` is `<Sheet>` + `<CollectionsTree
householdId={hid} onNavigate={close} />`, with **no edit to this file**. `onNavigate` fires
  after every row click and after a quick-add lands. `CollectionChips` carries a `TODO(m4)`
  at the spot where the `<md` affordance becomes the "File this recipe" button.
- **M5 (publish).** `EditCollectionDialog`'s header comment names where the publish section
  mounts (under the member list, above the footer) and what belongs in it. The picker's
  blocked row carries the combo's `TODO(m5)`. `CollectionSummary.publishedAt`/`recordStale`/
  `publishedByHandle` are already threaded through to both surfaces and simply unused.

### Commands run

```
pnpm --filter @buttery/lexicons build
pnpm typecheck
pnpm lint
pnpm format:check                      # 4 files reformatted with `pnpm exec oxfmt <files>`, then clean
pnpm test
```

### Test results

| command                     | result                                                        |
| --------------------------- | ------------------------------------------------------------- |
| `pnpm typecheck`            | **pass** — all 7 workspace projects                           |
| `pnpm lint` (oxlint)        | **pass**, exit 0 — 3 pre-existing warnings in unrelated files |
| `pnpm format:check` (oxfmt) | **pass** — "All matched files use the correct format"         |
| `pnpm test`                 | **pass** — web: 35 files, 564 passed / 253 skipped (no DB)    |
| └ `scope.test.ts`           | **pass** — 16/16                                              |

`db:migrate`/`db:codegen` were not needed: milestone 2 adds no schema.

### Verified in the browser

Driven with Playwright against the running dev stack at `http://127.0.0.1:3000`, signed in
as `chef.test`, household "The Test Kitchen" (33 seeded recipes), viewport 1440×900. Console
was clean — 0 errors, 0 warnings — on every page after the checks below.

- **Column collapse.** Collapsed on first load. Toggle shows it, `aria-expanded` flips,
  cookie becomes `collections_column=true`; a full reload keeps it open. Toggling back hides
  it and a reload keeps it hidden.
- **All four smart rows.** `mine` 33 A–Z; `recent` 33 in a visibly different (added-at)
  order; `favorites` 1 after starring Chana Masala, and the tree's count moved with it;
  `unpublished` 33.
- **Quick-add.** "Weeknights" created, appended, **selected** — URL became
  `?c=01M0GRQWTQWZ5CWZJ2KAW70ED1` — and the ledger switched to the empty-shelf state.
  Escape discards a half-typed name without creating anything. A second collection named
  "Weeknight dinners" was created while one already had that name: no error, appended and
  selected (§8).
- **Edit dialog.** Gear opens it; renaming to "Weeknight dinners" plus a description landed
  optimistically in the tree; the description then rendered in the scoped header. Removing a
  member from the dialog moved both the tree count and the dialog's own list on the same
  frame.
- **Chips + picker.** A recipe detail shows the folder-lock row with an "Add to a collection"
  chip; the picker filed the recipe (count 0 → 1, chip appeared behind the dialog) and the
  ledger, scoped to that collection, then showed exactly that one recipe.
- **URL round-trips.** Reloading on `?c=<id>` and on `?scope=favorites` both restore the
  scope from a cold page load. `?scope=banana` degrades to the whole box (param stripped by
  `.catch`), never a 404.
- **Deleted collection.** `?c=01M0DELETEDCOLLECTION0000` renders "This collection no longer
  exists." inline, with the tree and the box intact beside it.
- **Search carries through.** From `?scope=unpublished`, every ledger row's `href` is
  `/household/recipes/<id>?scope=unpublished`, and the detail route renders it.
- **Responsive.** At 900px wide with a recipe selected, the column and the ledger both yield
  to the detail pane, exactly as the ledger did before this milestone.
- **Keyboard.** The row gear is a real button at all times and becomes visible on focus
  (`group-focus-within`), not on hover alone.

### Notes for the next implementer

- **`src/components/pantry/LockedFeaturesStrip.tsx` still advertises Collections with a
  `soon` chip.** §2.9 named only the nav rail, and `components/pantry/**` was outside this
  milestone's file ownership, so it was left alone — but it is now wrong on the pantry home
  for a household with an empty box. One line to delete when someone owns that file.
- The ledger's filter bar no longer has a sort control **at all**. In-place re-sorting of a
  scoped view is deferred by §2.2; if it comes back it belongs beside `ScopedLedgerHeader`,
  not in the filter bar, and it must be inert for a collection scope (that order is the
  published array order).
- `resolveScope` is the only place that knows `?c=` beats `?scope=`. Anything that needs to
  know what the ledger is showing should call it rather than reading the params.
- The scoped ledger renders `scopeRows(...)` — for a collection, a straight map over
  `recipeIds` with unboxed ids dropped. M3's reorder must write back the _full_ current
  order, not the rendered subset, if a member is ever missing from the box.
