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
