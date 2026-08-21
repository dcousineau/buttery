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

---

## Milestone 3 — drag and drop

The three surfaces of §10.3, all of them native HTML5 drag and drop (§7 — no dnd-kit, no
drag library anywhere in this repo), all of them desktop-only, and each with a keyboard path
because a grip that only answers to a pointer is a feature half the household cannot use.

### What was built

**Two shared primitives, because this is now the app's third reorderable list.**

| file                                 | what it is                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `src/lib/reorder.ts`                 | The pure arithmetic: `moveItem`, `moveToInsertionPoint`, `moveByKey`, **`applyVisibleOrder`**                        |
| `src/lib/reorder.test.ts`            | 21 tests over it, including the exact compositions the ledger and the tree perform                                   |
| `src/components/ui/drag-reorder.tsx` | `insertionPointAt`, `DropLine`, `DragHandle` — the paint and the keyboard contract, shared by every reorderable list |
| `src/components/collections/drag.ts` | The two MIME types and `dragCarries`                                                                                 |

`LineEditor.tsx` — the canonical pattern this milestone was told to follow — now **imports**
those primitives instead of carrying its own copies (its private `DropLine`,
`insertionPointAt`, the `at > from ? at - 1 : at` off-by-one, and its hand-rolled grip span
are gone; behaviour is byte-identical, including the `aria-hidden` decorative grip). That is
the AGENTS rule about shared behaviour living in a shared `ui/` component rather than at the
call site, and it is why the drop line is the same 3px of ink in all three lists.

**The two MIME types** (`src/components/collections/drag.ts`):

- **`application/x-buttery-recipe`** — a recipe id, dragged from a ledger row. Two landings:
  a collection row (file it there) and the gap between two ledger rows (reorder).
- **`application/x-buttery-collection`** — a collection id, dragged inside the tree. One
  landing: the household's local list order.

They cannot cross-drop, and the mechanism is structural rather than hopeful: every target
reads `dataTransfer.types` in `dragover` — the one moment `getData` is deliberately blank —
and only calls `preventDefault()` for its own type, so the browser paints "no drop" for the
other drag instead of quietly accepting it. The same check makes a file, a text selection or
a link dragged in from another app inert over both lists.

**1. Collections-list reorder** (`CollectionsTree.tsx`, `CollectionRow.tsx`). The `<ul>`
reads the drag and computes an insertion point over `[data-collection-row]`; each row is the
drag source and draws the `DropLine` in its own top edge (and its bottom edge for the row at
the end, the one landing place no gap above a row can express). The write is
`reorderCollectionsMutation` — local-only, no re-put, exactly as §2.10 requires.

**2. Within-collection reorder** (`RecipeLedger.tsx`). Live only when
`scope.kind === "collection"` **and the search box is empty** and there is more than one row:
that order IS the published `recipes` array order, so it can only be rearranged while what is
on screen is the order itself and not a filtered view of it. `reorderCollectionRecipesMutation`,
optimistic through the M1 patch, so the rows settle in place and the tree's count never moves.

**3. Ledger card → collection row filing** (`CollectionsTree.tsx`). The row is the drop target
(here the row _is_ the destination, so there is nothing to measure), painted with the ink
outline the drop line is drawn in plus the `accent` fill. `addRecipesToCollectionMutation`,
and the answer is a resolved union rather than a throw, so all three arms are handled: filed,
already filed (a toast, because silence reads as a drag that missed), and `recipes_unpublished`
(a published shelf refusing a private recipe — M5's "Publish recipe & add" attaches to the
picker row, not here).

**The full-order write.** M2's note was right, and it is the one place this milestone could
have quietly corrupted data. The scoped ledger renders `recipeIds` mapped through the box with
unboxed ids dropped, so what someone drags can be a _subsequence_ of the collection's entries,
while `reorderCollectionRecipes` replaces the whole order. `applyVisibleOrder(fullOrder,
nextVisible)` folds the new on-screen order back into the full one: ids the ledger never
rendered keep their absolute slots, and the visible ones are dealt back into the slots they
occupied. Ids that are not in the collection at all are ignored — a stale cache is not a
licence to invent an entry. Both the ledger's drag and its keyboard path go through the one
`commitOrder`, so there is a single call site to get right, and `reorder.test.ts` asserts the
composition directly ("a drag in a collection-scoped ledger writes the FULL entry order").
The tree needs none of it: it renders every collection the household has, so its order is the
whole order by construction — and it still calls `applyVisibleOrder` in a test to prove the
identity.

### The keyboard path

`DragHandle` has two shapes, decided by one question: _is dragging this the only way to do
the job?_

- **Reordering** — nothing else in the app reorders a collection or an entry, so the grip is
  a real `<button>` in the tab order, named per row ("Reorder Weeknights", never ten buttons
  all called "Reorder"), carrying `aria-keyshortcuts`, and handling **`↑`/`↓` to move one
  place, `Home`/`End` to send the row to an end**. Both lists key their rows by id, so the
  focused handle travels with its row and focus survives the move. Each list also has its own
  `role="status"` live region that announces "Weeknights moved to 2 of 5." — the drop line is
  `aria-hidden` and a move is otherwise silent.
- **Filing** — already has a full non-drag path (the collections picker on the recipe detail,
  and M4's sheets), so in a non-reorderable scope the ledger's grip is a decorative
  `aria-hidden` span with a pointer `title`. A focusable control that does nothing when you
  press it is worse than no control.

Both grips are `max-md:hidden`, which is also what makes the whole gesture inert below `md`
(§7): a row is only `draggable` while its grip is held (`useDragHandle`), and a
`display: none` grip is never held. No media query in JS, no touch shim, nothing to keep in
sync — and nothing for milestone 4's sheet to work around.

### Deviations from §7, and why

1. **Two new shared modules (`lib/reorder.ts`, `ui/drag-reorder.tsx`) and one refactor of
   `LineEditor.tsx`.** §7 says to build on `useDragHandle` and `insertionPointAt`/`DropLine`,
   but the latter two were private to `LineEditor`. Copying them into two more files would
   have made three drop lines to keep in step; AGENTS says shared behaviour lives in the
   shared `ui/` component. The insertion-point maths moved to `lib/` because it is pure and is
   the only part of a drag this repo can test at all.

2. **The ledger's grip appears in _every_ scope, not only a collection scope.** §7 gives the
   scoped ledger drag handles, and filing by dragging a card onto a shelf is the third surface
   — which means the card has to be draggable everywhere, because "put this on that shelf" is
   the gesture the whole third column exists for. The grip changes its _name_ and its
   _shape_ with the scope (above), so it never claims to reorder a list that has no order.

3. **The card body drags too, not just the grip.** Not a decision so much as an honest note:
   both a ledger row and a tree row wrap a `<Link>`, and an anchor is natively draggable, so a
   drag begun on the row body starts an anchor drag that bubbles into the same `dragstart`
   handler and carries the same typed payload. It is left that way deliberately — §7 calls
   this surface "ledger-**card** → collection-row filing", and a forgiving target is the point
   — but it does mean `armed` gates the grip, not the row, on these two lists. The grips of
   `LineEditor`, whose rows hold text inputs, are unaffected: nothing there is an anchor.

4. **No pointer-only alternative to the reorder drag (WCAG 2.5.7).** The keyboard path is
   complete, and filing has a full click-only path (picker, sheets), but _reordering_ by
   pointer alone still requires a drag. The honest fix is a pair of move up/down controls in
   the edit dialog's member list — which is where a non-drag reorder naturally belongs, and
   that file is the concurrent agent's `TODO(m3)`. Flagged rather than smuggled in.

5. **The tree's grip is hover-revealed (`opacity-0`, `group-hover`/`group-focus-within`), the
   ledger's is always visible.** The tree row already reveals its gear this way and a second
   always-on icon in a 232px column would crowd the name; the ledger has the room and the grip
   is the only sign that a card can be dragged onto a shelf. Neither is hover-_only_: both are
   in the accessibility tree at all times, and the button shape takes focus and paints itself
   visible when a keyboard reaches it.

6. **Dragging is off while offline.** Writes are online-only (§6) and a reorder is a write, so
   `useIsOnline()` removes the grips and the drop targets rather than starting a drag that
   cannot be saved. This also means the row is not a filing target offline.

7. **`CollectionTreeRow` grew three props** (`leading` was already there for this milestone):
   `dropLine`, `drag`, and the drop paint. The drop line has to be a child of the row it hangs
   off — it is out of flow, so the row does not move when it appears — and the row is the only
   element that can carry `draggable`. The presence of `drag` is also what marks a row as a
   measurable slot (`[data-collection-row]`), so a smart row is never one.

### Not in this milestone, on purpose

- **The edit dialog's member-row reorder** keeps its `TODO(m3)`: `EditCollectionDialog.tsx`
  belongs to the concurrent mobile milestone and was not touched. Everything it needs is
  ready — `DragHandle`, `DropLine`, `insertionPointAt`, `moveToInsertionPoint` and
  `reorderCollectionRecipesMutation` — and its list is the collection's _whole_ entry order,
  so it can write `moveToInsertionPoint(recipeIds, …)` straight through without
  `applyVisibleOrder`.
- **Mobile drag** — none, by §7.

### Commands run

```
pnpm --filter @buttery/lexicons build
pnpm typecheck
pnpm lint
pnpm format:check                      # 1 file reformatted with `pnpm exec oxfmt <file>`, then clean
pnpm test
```

No schema, so no migration or codegen; no server change, so no db suite.

### Test results

| command                     | result                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm typecheck`            | **pass** — all 7 workspace projects                                                          |
| `pnpm lint` (oxlint)        | **pass**, exit 0 — the same 3 pre-existing warnings in unrelated components                  |
| `pnpm format:check` (oxfmt) | **pass** — "All matched files use the correct format"                                        |
| `pnpm test`                 | **pass** — web: 36 files, **585 passed** / 253 skipped (was 564, +21 from `reorder.test.ts`) |
| └ `reorder.test.ts`         | **pass** — 21/21                                                                             |

**Not verified in a browser.** The single shared Playwright session belonged to the concurrent
milestone-4 agent for the whole of this work, so none of the three drags has been exercised by
hand: what is asserted here is the arithmetic (unit-tested), the types (`tsc`), and careful
reading of the event plumbing against the two patterns already in the repo (`LineEditor`, the
meal planner's slot drops). The drags themselves — the drop line landing where the pointer
says, the ink outline on the shelf under the cursor, the arrow keys moving a focused row, and
the fact that a collection cannot be dropped on the ledger nor a recipe between two shelves —
still want a pass in a real browser.

### Notes for whoever picks this up next

- `applyVisibleOrder` is the guard rail, not a nicety: any future surface that renders a
  _filtered_ view of a collection and lets it be reordered must go through it, or it will
  unfile every row it did not render. The two current call sites both live in one
  `commitOrder` function per list.
- The two MIME types are the whole cross-drop story. A new drag (a meal-plan slot, say) needs
  its own `application/x-buttery-*` type and a `dragCarries` check in every target it passes
  over — never `text/plain`, which every other app on the machine also speaks.
- `DragHandle`'s two shapes are a decision about the _feature_, not about styling: give it
  `onMove` and it becomes a keyboard control, omit it and it is a pointer accelerator. Omit it
  only when the job has another complete path.
- `CollectionsSheet`'s `TOUCH_TREE` override (`[&_nav_li>button]:size-11`) also matches the
  tree's new grip button, but the grip is `max-md:hidden` and the sheet only exists below
  `md`, so the two never meet. Anything that starts showing the sheet at wider widths should
  re-check that.

---

## Milestone 4 — mobile

The feature reaches a phone. Everything the desktop column does, a left `Sheet` now does; the
two filing surfaces §7 names for mobile exist; the edit dialog becomes a full-height sheet
below `md`; and every target on those surfaces is at least 44px. **No drag anywhere** —
mobile has none by design (§7, "Mobile: no drag — sheets are the filing mechanism"), and the
desktop DnD in milestone 3 landed concurrently in files this milestone never opened.

### What was built

**New — `services/web/src/components/collections/`**

| file                     | what it is                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `CollectionsSheet.tsx`   | The `<md` strip + left `Sheet` wrapping `CollectionsTree`, plus the `TOUCH_TREE` restyle that makes the tree thumb-sized |
| `AddRecipesSheet.tsx`    | Many recipes → one shelf. Search, batched selection in tap order, one `addRecipesToCollection` call                      |
| `FileRecipeSheet.tsx`    | One recipe → many shelves. The mobile twin of the picker dialog; each tick files or unfiles immediately                  |
| `CollectionCheckRow.tsx` | The shelf row shared by the picker dialog and `FileRecipeSheet`, including the §2.4 blocked row. See deviation 2         |

**Changed**

- `EditCollectionDialog.tsx` — **two shells, one form**. `useIsMobile()` picks a `Dialog`
  (desktop) or a bottom `Sheet` at `data-[side=bottom]:h-svh` (mobile). Both are the same
  Base UI `Dialog` primitive underneath, so `DialogTitle`/`DialogClose`/`DialogFooter` work
  unchanged in either root and the form is byte-identical in both. The form was restructured
  into pinned header · one scrolling region · pinned footer, so a 22-recipe shelf never
  pushes Save off a phone screen. On mobile it also grows a 44px close button, an **"Add
  recipes"** button that opens `AddRecipesSheet`, 44px row-removal buttons, and it drops the
  member list's inner `max-h-[14rem]` scroller (a scroller inside a scroller is a thumb trap;
  the desktop keeps it).
- `CollectionChips.tsx` — the `TODO(m4)` is discharged. Below `md` the chips stop being
  buttons and a full-width 44px **"File this recipe"** button appears under them, opening
  `FileRecipeSheet`. Desktop is untouched.
- `CollectionPickerDialog.tsx` — its rows are now `CollectionCheckRow`. No behaviour change.
- `routes/household.recipes.tsx` — the ledger gained a wrapper column carrying the responsive
  sizing it used to carry alone (`lg:w-[360px] lg:shrink-0`, the `hidden lg:flex`
  hide-on-selection), with `CollectionsSheet` (`md:hidden`) as its head. The strip and the
  ledger therefore appear and disappear together.
- `components/ui/checkbox.tsx` — `CheckboxRow` gained a `disabled` prop. See deviation 3.

### Deviations from §7, and why

1. **The mobile entry point is a strip above the ledger, and it is labelled with the active
   scope, not the word "Collections".** §7 names `CollectionsSheet` but not what opens it.
   The ledger's own collections toggle is `max-md:hidden` and `RecipeLedger.tsx` belongs to
   the concurrent DnD milestone, so the trigger had to live in the layout route. Labelling it
   `scopeLabel(scope)` makes one strip do the two jobs the desktop needs two columns for —
   "you are looking at Weeknights; tap to look at something else". It costs a little
   redundancy with `ScopedLedgerHeader` on non-default scopes, which is the half that also
   carries the description and the clear-scope control.

2. **`CollectionCheckRow.tsx` — one file §7's table does not list.** The picker dialog and
   the file sheet ask the same question and must refuse the same case (published shelf,
   private recipe — §2.4), and that refusal is precisely the row milestone 5 hangs "Publish
   recipe & add" off. Two copies would mean M5 has to find both. The row takes a `size` so
   the dialog keeps its `sm` density and the sheet gets the 44px one.

3. **`CheckboxRow` gained a `disabled` prop** (`components/ui/checkbox.tsx`). `AddRecipesSheet`
   shows recipes already on the shelf as ticked-but-not-tickable — unticking there would mean
   "unfile", which belongs to the edit sheet's member list where it is one deliberate control.
   A disabled native checkbox still announces "checked" to a screen reader, which a
   look-alike `<div>` would not. Default is `false`, so every existing call site (grocery,
   plan, picker) is byte-identical. This is the AGENTS rule about shared behaviour living in
   the shared `ui/` component.

4. **The tree is restyled from _outside_ for touch — `TOUCH_TREE` in `CollectionsSheet.tsx`.**
   Two things a 232px desktop column gets away with and a phone does not: its rows are 30.6px
   (measured), under the 44px floor; and the row gear that opens the edit sheet is
   `opacity-0` until hover, so on a touch device the milestone's own full-height edit sheet
   would have had **no visible way in** (BRAND.md is explicit that cook-mode-class touch
   surfaces carry no hover-dependent controls). Both are fixed with arbitrary-variant classes
   on the `className` `CollectionsTree` already accepts, because `CollectionRow.tsx` belongs
   to the concurrent DnD milestone and milestone 2 built the tree so that mobile would not
   have to edit it. **This is a seam, not an ideal**: the rules belong in `CollectionRow` under
   a `pointer-coarse:` variant, where the desktop column would inherit them too. Whoever owns
   that file next should move them and delete `TOUCH_TREE`.

5. **`AddRecipesSheet` batches; `FileRecipeSheet` saves on every tick.** §7 describes both
   only as "44px checkbox rows". They differ because the server appends `recipeIds` in the
   order it receives them (§5): filing fifteen recipes one request at a time would be fifteen
   optimistic patches racing one another's `onSettled` invalidation, and the resulting shelf
   order would be whichever response landed last. One call is also the only way the shelf
   order matches the order they were ticked — verified below.

6. **"Add recipes" is mobile-only**, per §7's table ("Mobile: add many recipes to one
   collection"). The desktop adds from the recipe side (the picker) or, from milestone 3, by
   dragging a ledger card onto a shelf row. If that ever feels thin on the desktop, the sheet
   already takes a `collection` and a `recipes` array and would work in a dialog unchanged.

7. **`AddRecipesSheet` is nested inside the edit sheet** rather than replacing it. Closing the
   edit sheet to file recipes would drop a half-typed name and description. Base UI stacks the
   two dialogs correctly — verified in the browser.

8. **No `DetailPane.tsx` change was needed.** §7 lists the mobile "File this recipe" button
   as a `DetailPane` change, but M2 had already mounted `CollectionChips` there and the button
   is a shape `CollectionChips` takes below `md`, so the pane is untouched. (The recipe
   publish-confirm copy §7 also assigns to `DetailPane` is a milestone-5 deliverable and was
   left alone.)

### Seams milestone 5's UI pass needs to know about

- **The blocked row lives in one place now** — `CollectionCheckRow.tsx`, `TODO(m5)`. Adding
  "Publish recipe & add" there lights it up in the desktop dialog _and_ the mobile sheet at
  once. `AddRecipesSheet`'s footer carries the same `TODO(m5)` for the whole-selection version
  (it already renders the refused titles from `recipes_unpublished`'s `recipeIds`; it needs
  the action, and `publishRecipeIds` threaded through the port — M1 deviation 2).
- **The publish section still mounts in `EditCollectionForm`, under the member list and above
  the footer** — that is inside the one scrolling region, so it scrolls with the rest on a
  phone and needs no layout of its own. `mobile` is already in scope if the section wants
  44px controls; use it rather than a second `useIsMobile()`.
- **Every mobile control in this milestone is 44px by explicit class**, not by size token.
  `Button size="lg"` is 36px, not 44 — anything M5 adds to a sheet needs `h-11` (or `min-h-11`
  on a row) the same way, or it will be the one target that fails the §7 floor.
- **`FileRecipeSheet` and `CollectionPickerDialog` take identical props.** If M5 changes one
  surface's contract, change both — `CollectionChips` picks between them on `useIsMobile()`
  alone.

### Commands run

```
pnpm --filter @buttery/lexicons build
pnpm typecheck
pnpm lint
pnpm format:check                      # 2 files reformatted with `pnpm exec oxfmt <files>`, then clean
pnpm test
process-compose process restart web    # twice; see "A note on the dev stack" below
```

### Test results

| command                     | result                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`            | **pass** — all 7 workspace projects                                                                              |
| `pnpm lint` (oxlint)        | **pass**, exit 0 — 3 pre-existing warnings in unrelated files (`CookPhase`, `PlanDaysAgenda`, `useWindowedRows`) |
| `pnpm format:check` (oxfmt) | **pass** for every file this milestone owns                                                                      |
| `pnpm test`                 | **pass** — web: 36 files, 585 passed / 253 skipped (no DB)                                                       |

No new unit tests: everything here is DOM, and the repo has no DOM tests (§9). The pure
functions this milestone leans on (`scope.ts`'s `searchRows`, `optimistic.ts`'s
`withRecipesFiled`) are already covered by milestones 1 and 2.

### Verified in the browser

Playwright against the running dev stack at `http://127.0.0.1:3000`, signed in as `chef.test`,
household "The Test Kitchen", 33 seeded recipes. Viewport **390 × 844** (iPhone-class) unless
noted. Console was clean — 0 errors, 0 warnings — on every check below.

- **The sheet tree opens, closes, and closes behind a tap.** The strip's trigger opens the
  left sheet (288px wide, full height); the 44px close button and the backdrop both dismiss
  it; tapping **Favorites** navigated to `?scope=favorites`, closed the sheet, relabelled the
  trigger "Favorites", and the ledger showed the one favourited recipe.
- **Quick-add works from the sheet.** Typing "Phone shelf" + Enter created it, navigated to
  `?c=01M0GTTN1M4C7HH5XY956MJVQB`, **closed the sheet**, and relabelled the trigger — the
  `onNavigate` path M2 left for this milestone, exercised end to end.
- **"Add recipes" files several recipes into a collection.** Opened from the edit sheet
  (nested on top of it, both dialogs stacked correctly). Ticked Air-Fryer Chicken Parmesan,
  Arroz con Pollo, Beef Bourguignon → the button read "Add 3 recipes" → the shelf's member
  list came back **in tap order, appended after the existing member**, and the tree's count
  went 1 → 4. A second pass added 18 more in one call (count → 22).
- **"File this recipe" files one recipe into several collections.** On Chana Masala's detail
  the chips row is a read-out plus a full-width "File this recipe" button; the sheet ticked a
  second shelf (its count 0 → 1, a second chip appeared behind the sheet, the footer status
  read "On 2 shelves"), and unticking it reversed all three on the same frame.
- **The edit sheet is genuinely full-height and scrolls.** Measured: popup `top: 0`,
  `height: 844` = viewport height, width 390. With 22 members the middle region reports
  `scrollHeight 1529` vs `clientHeight 662` and scrolls to 867, while the header stays at
  `top: 2` and the footer at `bottom: 844`.
- **Every touch target measured ≥ 44px**, with `getBoundingClientRect()` rather than by eye:
  - sheet tree — all 6 rows exactly **44**, the quick-add row **44**, both edit gears **44 × 44**
    at computed `opacity: 1` (30.6px and `opacity: 0` before `TOUCH_TREE`);
  - `AddRecipesSheet` — all 33 recipe rows exactly **44** (`[...new Set(heights)] === [44]`);
  - `FileRecipeSheet` — both shelf rows **48**;
  - edit sheet — close **44**, "Add recipes" **44**, each row's remove **44 × 44**, Cancel and
    Save **44**;
  - the strip's own trigger **44**.
- **Desktop is not regressed.** At **1440 × 900**: nav rail, 232px collections column, 360px
  ledger (with milestone 3's grips), detail pane — unchanged, and the `md:hidden` strip
  measures 0px. The edit **dialog** still renders as a dialog (now with a pinned header and
  footer and a scrolling middle) and the picker dialog's rows are pixel-identical to
  milestone 2's through the shared row component.
- **The in-between width still yields.** At **900 × 840** with a recipe selected, the column,
  the strip and the ledger all give way to the detail pane; with nothing selected the column
  is back at 232px and the strip is still 0px.

### A note on the dev stack, for the next implementer

`pnpm --filter @buttery/lexicons build` (which `pnpm typecheck` also runs, and which the
concurrent milestone-3 agent ran too) uses `lex build --clear`. It deletes
`packages/lexicons/src/generated/**` before rewriting it, and the running Vite dev server
caches the miss: every server fn then 500s with `Failed to load url …/generated/exchange/recipe/recipe.ts`
long after the file is back on disk. It is not a code fault and no page change fixes it —
`process-compose process restart web` does, in about fifteen seconds. It happened twice
during this milestone.

---

## Milestone 5 (UI) — the publish surface

The last milestone, and the half of §10.5 the server pass left: the owner-only publish
section, the three warning dialogs whose copy §2.5 and §2.7 mandate, the "Publish recipe &
add" combo, and the staleness notice every re-putting write can now answer with. Plus the
two cleanups milestones 3 and 4 explicitly handed on — the WCAG 2.5.7 pointer-only reorder
and the `TOUCH_TREE` seam.

### What was built

**New — `services/web/src/components/collections/`**

| file                         | what it is                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `PublishConfirmDialog.tsx`   | §2.5's copy, plus the `recipes_unpublished` preflight list and any PDS refusal, kept on screen                 |
| `UnpublishConfirmDialog.tsx` | §2.7's copy for "the record goes, the shelf stays"                                                             |
| `DeleteCollectionDialog.tsx` | §2.7's copy for "both go", built on the shared `ConfirmDialog`; a second wording for an unpublished shelf      |
| `use-stale-toast.ts`         | The one place "Saved — couldn't update @sam's published copy yet" is written, its Retry, and `publisherName()` |
| `use-file-recipe.ts`         | The filing behaviour the picker dialog and the mobile sheet now share, combo and all                           |

**New — `services/web/src/components/`**

| file                      | what it is                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `AtprotoReauthDialog.tsx` | "Buttery needs new permissions" — the single prompt every `scope_error` routes to, across four call sites. Built on `ConfirmDialog` |

**Changed**

- `EditCollectionDialog.tsx` — the publish section (`PublishSection`) mounts exactly where
  milestone 4 said it would: under the member list, above the footer, inside the one
  scrolling region. It carries "Published by @handle" (or "Household only — this shelf isn't
  on the network."), the `record_stale` badge with its member-level retry, and the owner's
  Publish / Unpublish / Delete. The member list gained **move up / move down** per row.
- `CollectionCheckRow.tsx` — the blocked row grew its **"Publish recipe & add"** action; the
  `TODO(m5)` is gone.
- `CollectionPickerDialog.tsx`, `FileRecipeSheet.tsx` — reduced to layout over `useFileRecipe`.
- `AddRecipesSheet.tsx` — the footer's refusal grew **"Publish N recipes & add"** over the
  whole selection; its `TODO(m5)` is gone.
- `CollectionsTree.tsx`, `RecipeLedger.tsx` — drag-to-file and the collection-scoped reorder
  now surface `stale`.
- `CollectionRow.tsx`, `QuickAddRow.tsx`, `CollectionsSheet.tsx` — `TOUCH_TREE` deleted, its
  rules moved onto the elements under `pointer-coarse:`.
- `DetailPane.tsx` — the **recipe** publish-confirm copy now names the handle (§2.5 applies
  to recipes too).
- `components/ui/toast.tsx` — `action` and `sticky` on a toast; `components/ConfirmDialog.tsx`
  — a `children` body slot and a `touch` (44px) footer; `components/recipes/context.ts` +
  `routes/household.recipes.tsx` — `pushToast(message, options?)`.
- `lib/api/queries.ts` — `myHouseholdsQuery()` (the caller's role, for the owner gate);
  `lib/api/mutations.ts` — `publishRecipeIds` on the filing mutation, plus the box
  invalidation the combo needs.
- `server/recipes-write.ts` — a **bug fix**, see deviation 7.

### The mandated copy, as shipped

**Publish a collection** (`PublishConfirmDialog`, title "Publish this collection?"):

> This writes **{name}** to your own atproto account, @chef.test — the record lives on your
> PDS, where any app on the network can read it. Everyone in your household can still edit
> the shelf, and every future update to it goes out from @chef.test too, whichever member
> makes the edit.

**Unpublish** (title "Unpublish this collection?"):

> This deletes the record from @chef.test's PDS. **{name}** and everything on it stay in your
> box — only the public copy goes. Deleting from a PDS doesn't guarantee removal from the
> wider internet: relays, mirrors and caches may already hold a copy.

**Delete** (title "Delete this collection?", published shelf):

> This deletes **{name}** from your box and deletes its record from @chef.test's PDS. Your
> recipes stay where they are — only the shelf goes. Deleting from a PDS doesn't guarantee
> removal from the wider internet: relays, mirrors and caches may already hold a copy.

An unpublished shelf gets only the first sentence pair ("This deletes {name} from your box.
Your recipes stay where they are — only the shelf goes.") — inventing a PDS caveat for a
record that never existed teaches people to ignore it on the one that did.

**Publish a recipe** (`DetailPane`, §2.5 applied to recipes):

> This writes the recipe to your own atproto account, @chef.test — a portable record on your
> PDS that any app on the network can read. Every future update to it goes out from
> @chef.test too, whichever member of your household makes the edit. It's hard to undo.

**Stale** (the toast, from `use-stale-toast.ts`): title "Saved — couldn't update @chef.test's
published copy yet", description "Your change is saved here. The next edit to this collection
will try again, or retry now.", one **Retry** button, and `sticky` so it does not expire
under someone reading it. A retry that fails again re-pushes as "Still couldn't update
@chef.test's published copy"; one that succeeds says "@chef.test's published copy is up to
date". The persistent twin is the edit dialog's badge: **Out of date** · "@chef.test's
published copy is behind what's here." · Retry.

### How each result variant surfaces

| call                            | variant                       | what the person sees                                                                                                           |
| ------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `publishCollection`             | `ok`                          | Dialog closes, toast "Published as @handle", section flips to "Published by @handle"                                           |
|                                 | `recipes_unpublished`         | Dialog **stays open**, lists the private titles (capped + scrolling), says publish them first                                  |
|                                 | `flag_disabled`               | Dialog stays open: "Publishing is switched off right now. Nothing was published."                                              |
|                                 | `scope_error`                 | Dialog closes, `AtprotoReauthDialog` opens                                                                                     |
|                                 | `publisher_unavailable`       | "We couldn't reach @handle's PDS. Nothing was published — try again in a bit."                                                 |
| `unpublishCollection`           | `ok`                          | Toast "Unpublished — the record is gone from @handle's PDS" (or "That shelf wasn't published" when `unpublished: false`)       |
|                                 | `scope_error` / `publisher_…` | Re-authorize prompt / "…Nothing changed — the record is still published."                                                      |
| `deleteCollection`              | `ok`                          | Toast, dialog and edit surface close, and `?c=<id>` is navigated away from so the ledger never answers with "no longer exists" |
|                                 | `publisher_unavailable`       | "We couldn't reach @handle's PDS. **Nothing was deleted** — the shelf and its published record are both still here."           |
| `addRecipesToCollection`        | `ok` + `stale`                | Filed, plus the stale toast                                                                                                    |
|                                 | `recipes_unpublished`         | Blocked row / footer notice **with the combo action**                                                                          |
|                                 | `flag_disabled`               | "Publishing is switched off right now — nothing was filed"                                                                     |
|                                 | `scope_error`                 | `AtprotoReauthDialog` (all three filing surfaces mount one)                                                                    |
| `update` / `reorder` / `unfile` | `stale: true`                 | The stale toast, from whichever surface made the write                                                                         |
| `retryCollectionSync`           | `{ stale }`                   | Success or "still couldn't" toast; **shown to members, not only owners**                                                       |

`publisher_unavailable` always names a person: the variant's `handle`, falling back to
`CollectionSummary.publishedByHandle` (and, for a _publish_, to the acting owner's own handle
— they are the publisher-to-be). `publisherName()` normalizes the `@`, because
`resolveAdderHandles` already prefixes one and the session's handle does not; without it the
first publish rendered "Published by @@chef.test", which the browser pass caught.

### The two cleanups

**WCAG 2.5.7 — a pointer-only reorder.** Milestone 3's own note said the honest home was the
edit dialog's member list, and it is: each row now carries **Move up / Move down** buttons
(disabled at the ends, `aria-label` naming the recipe, a `role="status"` line announcing
"Chana Masala moved to 2 of 2"). They write the collection's **full** entry order through
`applyVisibleOrder`, exactly as the ledger's drag does, so a member the box no longer holds
keeps its slot. The `TODO(m3)` in `EditCollectionDialog.tsx` is discharged. On a phone these
are the _only_ reorder path — there is no drag below `md` — so they are 44px there.

**The `TOUCH_TREE` seam.** The six arbitrary-variant rules milestone 4 applied from
`CollectionsSheet` now live on the elements they describe, under `pointer-coarse:`: the row
`<li>` and its `<a>` (`min-h-11`), the gear (`size-11` + `opacity-100` — a touch device has
no hover to reveal it with), and the quick-add trigger, form and input. `TOUCH_TREE` is
deleted; the sheet passes `className="h-full"` and nothing else. The variant keys off the
**input device** rather than the viewport, which is what the rule was always about: a
touchscreen laptop now gets the big targets the phone got, and a narrow desktop window keeps
the dense ones. Verified both ways in the browser (below).

### Deviations, and why

1. **`myHouseholdsQuery()` — a new factory in `queries.ts`.** The owner gate needs the
   caller's role and nothing in the session carries one: `ensureActiveHousehold` answers an id
   and a name, and the members list is a different, household-scoped read. It is keyed on the
   already-reserved `keys.me.households()`, takes no argument (it is household-independent),
   and decides only what to _draw_ — every one of these writes is `assertMember`-gated
   server-side regardless.

2. **`useFileRecipe` — one file §7's table does not list.** Milestone 4's note said the picker
   dialog and the file sheet take identical props and must change together. This milestone
   changed both (the combo, the stale notice, the re-authorize prompt), so the behaviour moved
   into a hook and the two components became layout. Same reasoning as `CollectionCheckRow`
   one milestone earlier.

3. **A shared `AtprotoReauthDialog`.** Four collections call sites can answer `scope_error`
   (publish, unpublish, delete, and the combo in each of three filing surfaces). Four copies
   of that paragraph would drift on the first edit. `DetailPane` and `RecipeForm` keep their
   own older, recipe-specific wording — folding them in is a tidy-up for whoever owns those
   files next, not a collections change.

4. **`ConfirmDialog` gained `children` and `touch`; `Toast` gained `action` and `sticky`.**
   Both additive with defaults, so every existing call site is byte-identical — the same move
   milestones 2 and 4 made on `CheckboxRow`. `children` exists because `description` renders
   inside a `<p>` and the blocked-recipes list and the failure notice are blocks; `touch`
   because a dialog opened from a phone sheet needs the feature's 44px floor and
   `Button size="lg"` is 36px. `sticky` because a toast carrying a Retry must not expire in
   four seconds.

5. **The stale notice is handled in each mutation's own `onSuccess`, not per call.** Saving
   closes the edit dialog, and query-core skips a `mutate(vars, { onSuccess })` callback once
   the observer has no listeners — so the first implementation dropped the notice exactly when
   the write it describes had outlived its dialog. Options-level callbacks run on the mutation
   itself and survive the unmount. (Caught in the browser, not by types.)

6. **Box removal does not raise a stale toast.** `unboxRecipe` returns `staleCollectionIds`,
   but the `removeRecipeFromHousehold` **server fn** answers `{ ok: true }` and this milestone
   changed no server contract to widen it. The person is also navigating away from the recipe
   at that moment. The badge in the edit dialog still tells the truth, and the next write to
   the collection clears it.

7. **A server bug fix outside this milestone's scope: `publishRecipe` could never succeed.**
   `runPublishExisting` validated `buildRecordFromRow`'s output directly, and that builder
   assembles the _author's_ columns only — `createdAt`/`updatedAt` are the server's to stamp
   (`recipe-record.ts`). So **every** publish of an already-saved recipe returned
   `invalid: Missing required key "createdAt"` and nothing ever reached a PDS. It is fixed
   here (stamp before validating; `createdAt` = the row's frozen `record_created_at`, else its
   `indexed_at`, else now) because milestone 5's own "Publish recipe & add" combo calls that
   exact path — the escape hatch was dead on arrival without it, and the first browser attempt
   proved it. `recipes-write.db.test.ts` gained the regression test (it fails with the stamp
   removed; verified both ways).

8. **`Globe` and the chevrons are new to the icon vocabulary.** BRAND.md's list had no glyph
   for "public on the atproto network" — `lock` had no opposite. `globe`, `refresh-cw`,
   `chevron-up` and `chevron-down` were added to that list in `docs/BRAND.md`, with a line
   pairing `globe`/`lock`. No token or form state changed, so no `/design-sync` was pushed.

9. **The publish dialog lists the blocking recipes but does not offer to publish them all.**
   §5 gives the combo to _filing_, and `publishCollection` has no equivalent parameter, so the
   dialog names the titles (capped at ~8.5rem and scrolling — a 20-title list otherwise pushes
   the dialog's own buttons off a phone) and leaves the decision where the server put it.

### Commands run

```
pnpm --filter @buttery/lexicons build
pnpm typecheck
pnpm lint
pnpm format:check                      # 3 files reformatted with `pnpm exec oxfmt <files>`, then clean
pnpm test
DATABASE_URL=<services/web/.env> pnpm --filter @buttery/web exec vitest run --project db
process-compose process restart web    # once, after the first `lex build --clear`
```

The db project was run because deviation 7 changes server behaviour. `pnpm test:db` was again
not usable (it wraps `railway run`, and this environment has no Railway login).

### Test results

| command                     | result                                                                      |
| --------------------------- | --------------------------------------------------------------------------- |
| `pnpm typecheck`            | **pass** — all 7 workspace projects                                         |
| `pnpm lint` (oxlint)        | **pass**, exit 0 — the same 3 pre-existing warnings in unrelated components |
| `pnpm format:check` (oxfmt) | **pass** — "All matched files use the correct format"                       |
| `pnpm test`                 | **pass** — web: 36 files, 585 passed / 254 skipped                          |
| `vitest run --project db`   | **pass** — 8 files, **254 passed** (was 253; +1 regression test)            |

No new unit tests beyond that one: everything else here is DOM, and the repo has no DOM tests
(§9). The pure functions this milestone leans on (`applyVisibleOrder`, the optimistic patches)
are covered by milestones 1 and 3.

### Verified in the browser — against the real local PDS

Playwright against the running stack at `http://127.0.0.1:3000`, signed in as `chef.test`,
household "The Test Kitchen", `ATPROTO_PUBLISH_ENABLED=true`. Every publish below is a real
`com.atproto.repo.*` call to the dev PDS at `localhost:2583`, and every one was confirmed by
fetching the record back with `getRecord` and by reading the DB columns. Console: **0 errors,
0 warnings** throughout.

- **Publishing a recipe** — Chana Masala went public (`at://did:plc:b65…/exchange.recipe.recipe/seed-chana-masala`
  with a cid). This is what surfaced deviation 7; before the fix the call answered `invalid`
  and the UI silently did nothing.
- **Publishing a collection containing it** — the PDS minted the TID `3mtkkhq3sdc2y`, all seven
  publish columns were stamped, and the record came back holding one strongRef with both
  halves. An **empty** shelf published too, with `recipes` omitted entirely (the lexicon allows
  it, §8).
- **The blocked path** — a private recipe (Beef Bourguignon) against that published shelf
  rendered the dashed blocked row with its lock and its explanation, in the desktop dialog and
  in the mobile sheet.
- **The combo** — "Publish recipe & add" published the recipe and filed it in one call; the
  record came back with two refs, `createdAt` frozen and `updatedAt` moved. The **Unpublished**
  smart row dropped 33 → 31 on the same frame, which is the box invalidation the mutation now
  does. The mobile whole-selection version ("Publish 2 recipes & add", 44px) published both and
  filed them in tap order.
- **Reordering** — the edit dialog's Move down swapped two members, announced "Chana Masala
  moved to 2 of 2", and the published record's array order followed. The ledger's keyboard
  reorder did the same from the other surface.
- **Staleness, for real** — `process-compose process stop atproto-dev-env`, then a rename:
  the row saved, `record_stale` became true, the sticky toast said "Saved — couldn't update
  @chef.test's published copy yet" **after the dialog had closed**, and the edit dialog showed
  the Out of date badge. Retry with the PDS still down answered "Still couldn't…"; with the PDS
  back it re-put the rename, cleared `record_stale`, and said "@chef.test's published copy is
  up to date".
- **Unpublish** — the record 404s on the PDS afterwards, the seven columns are null, and every
  local row (including all entries) survived.
- **Delete, both ways** — with the PDS stopped, the dialog stayed open saying "We couldn't
  reach @chef.test's PDS. Nothing was deleted — the shelf and its published record are both
  still here", and the DB confirmed the row was untouched. With the PDS back, the same button
  deleted the record and the local rows, closed the dialog, dropped the shelf from the tree and
  navigated off `?c=<id>`. The recipes stayed in the box.
- **Touch, measured under a real coarse pointer** (CDP `Emulation.setTouchEmulationEnabled`,
  390×844): every tree row **44px**, every link 44px, both gears **44×44 at opacity 1**, the
  quick-add row 44px — the same numbers `TOUCH_TREE` produced, now from `pointer-coarse:`. The
  publish section's buttons in the edit **sheet** are 44px, as are the confirm dialogs' footer
  buttons (`touch`), the blocked row's combo, and the batch combo.
- **Desktop is pixel-unchanged** (1440×900, `pointer: fine`): tree rows **31.5px**, gears
  **24px at opacity 0**, quick-add 31.5px — identical to the measurements taken before the
  `TOUCH_TREE` move.

### Notes for whoever picks this up next

- **`retryCollectionSync` is member-level and the UI treats it that way.** The stale badge and
  its Retry render for everyone; only Publish / Unpublish / Delete are behind the owner check.
  If a future surface hides staleness behind the owner gate it will strand the member who made
  the edit.
- **The non-owner path was not exercised in a browser** — the dev stack has one account, and
  it owns the household. The gate is `myHouseholdsQuery()` → `role === "owner"`, and the server
  refuses regardless.
- **`publisherName()` is the only place a handle gets its `@`.** Two sources spell it
  differently; anything new that renders a publisher should go through it.
- The **atproto cron sync still does not read collection records** (§2.12, push-only v1), so
  nothing round-trips a published collection back into the index. A sweep after publishing is
  still `pnpm --filter @buttery/atproto-cron-sync sync:once`, and it will ignore these records.
