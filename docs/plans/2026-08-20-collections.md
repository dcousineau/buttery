# Collections

**Date:** 2026-08-20
**Branch:** `feat/collections`
**Status:** Approved spec, awaiting implementation.
**Design:** Claude Design project "Collections sidebar" (claude.ai/design project `f2336a81-3050-4e16-9f5f-ea832b8a1a94`, file `Collections sidebar.dc.html`). Desktop artboards 1a–1e: collapsed-by-default third column inside the Recipes page, smart rows, inline quick-add row, scoped ledger with drag handles, edit modal. Mobile artboards 2a–2f: left Sheet tree, "Add recipes" sheet, "File this recipe" sheet, full-height edit sheet.

> **Implementers: log your work to `docs/plans/results/2026-08-20-collections-results.md`.** Create the file when you start milestone 1. Record per milestone: what you built, deviations from this spec (with reasons), commands run, test results, and anything the next milestone's implementer needs to know. Update it as you go, not retroactively.

---

## 1. Context

Buttery is a household recipe manager. Collections are named, re-orderable groups of recipes: household-scoped (like all Buttery data — see the privacy-scope principle: household is the minimum scope), simple, and mapping almost directly onto the vendored atproto lexicon `exchange.recipe.collection` (`packages/lexicons/lexicons/exchange.recipe.collection.json`).

Lexicon facts (verified against the vendored file; it is unpatched upstream — no PATCHES.md row):

- `name`: string, required, maxLength 100 (graphemes 64 — enforce 100 bytes / 64 graphemes like the PDS will).
- `text`: string, optional, maxLength 1000 (graphemes 640). We call this `description` locally.
- `recipes`: **optional** array of `com.atproto.repo.strongRef` (`{uri, cid}`). **Array order IS the collection order.** An absent array is legal (empty collection).
- `createdAt`, `updatedAt`: required datetimes.
- Record key type: **`tid`**. Unlike the recipe lexicon (key `any`), our app ULID **cannot** be the rkey. The PDS mints the TID when `createRecord` is called without an rkey (verified against `@atproto/lex-client@0.3.3`: rkey is optional for tid-keyed records; parse the minted rkey off the returned `uri`). Do **not** add a dependency to mint TIDs client-side — the `TID` class only exists in transitive `@atproto/common-web`.

## 2. Locked decisions (user-approved 2026-08-20)

1. **Both orderings manual.** The collections list (household-wide; new collections append at bottom) AND recipes within a collection (drag-to-reorder on desktop). The design mock's "alphabetical" note is overridden.
2. **All four smart rows**: My recipes (A–Z — the default landing scope), Recently added (whole box, `added_at` desc), Favorites (`household_recipe.favorite` already exists), Unpublished. Smart rows **replace** the ledger's sort dropdown AND the existing "My recipes" lock-chip in `RecipeLedger.tsx` (that chip is really an unpublished-only filter — subsumed by the Unpublished row). In-place re-sorting of scoped views is deferred.
3. **Full atproto publish in v1**, gated by the existing fail-closed PostHog flag `isAtprotoPublishEnabled(did)` (`src/lib/posthog-server.ts:84`). PDS mints the TID rkey.
4. **Publish is blocked** until every member recipe of the collection is itself published. Filing a private recipe into a published collection is blocked, with a combined **"Publish recipe & add"** escape hatch in the picker/sheets.
5. **Multi-editor via the publisher's session.** The record lives on the publishing member's PDS. Any member's edit re-puts the record server-side via the publisher's stored OAuth session (`getUserRecipeClient(publishedByDid)`). UI always shows "Published by @handle"; shows "Updating as @handle" when a different member edits; publish confirmation dialogs (for collections AND recipes) state that future updates will come from @handle regardless of which household member edits. If the publisher's session can't be restored, set `record_stale` and refresh on a later write; surface with a retry affordance.
6. **strongRef staleness**: refs are recomputed on collection writes only. Editing a recipe never republishes collections that contain it.
7. **Unpublish AND delete** both exist, owner-only. Unpublish = `deleteRecord` on the PDS, keep the local collection. Delete = local + PDS. Both get warning dialogs stating that deleting from the PDS does not guarantee removal from the wider internet (relays, mirrors, caches).
8. **Permissions**: any member creates/edits/reorders/files/unfiles. Owners only for publish/unpublish/delete — `assertMember(did, householdId, "owner")` (`src/server/authz.ts:56`).
9. **Nav rail**: delete the `{ label: "Collections", icon: FolderLock, soon: true }` entry (`src/components/AppSidebar.tsx:30`). Collections live inside the Recipes page, not the rail.
10. **Collections-list order is local-only** — never published. Within-collection order publishes as the `recipes` array order.
11. **Removing a recipe from the box unfiles it from all household collections** in the same transaction, then re-puts affected published collection records post-commit.
12. **Push-only v1.** The atproto cron sync is NOT extended to read collection records (its plan doc §7 explicitly defers this).

## 3. Database

One migration. Scaffold with `pnpm --filter @buttery/web db:migrate:new create_recipe_collection_tables` (**never hand-name migration files**), then `db:migrate:up`, then `db:codegen` (`src/db/types.ts` is generated — never hand-edit).

Names avoid collision with the existing `atproto_collection_recipe` table (cron-sync's inbound index, unrelated).

### `recipe_collection`

| column              | type                           | notes                                                              |
| ------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `id`                | text PK                        | app ULID                                                           |
| `household_id`      | text NOT NULL                  | FK → `household.id` ON DELETE CASCADE                              |
| `name`              | text NOT NULL                  | CHECK `char_length(name) BETWEEN 1 AND 100`                        |
| `description`       | text                           | CHECK `char_length(description) <= 1000`; NULL = none              |
| `position`          | integer NOT NULL               | dense 0..n-1 per household; local-only, never published            |
| `created_by_did`    | text NOT NULL                  | attribution                                                        |
| `created_at`        | timestamptz NOT NULL           | default now                                                        |
| `updated_at`        | timestamptz NOT NULL           | default now                                                        |
| `published_by_did`  | text                           | publisher's DID; drives `getUserRecipeClient` on re-puts           |
| `rkey`              | text                           | PDS-minted TID, parsed from create's returned uri                  |
| `uri`               | text                           | at:// uri of the published record                                  |
| `cid`               | text                           | latest known cid (CAS input for swapRecord)                        |
| `rev`               | text                           | latest known repo rev                                              |
| `published_at`      | timestamptz                    | first publish time                                                 |
| `record_created_at` | timestamptz                    | frozen `createdAt` for re-puts (record's createdAt must not drift) |
| `record_stale`      | boolean NOT NULL default false | true when a re-put failed; retried on next write                   |

Constraints and indexes:

- All-or-none publish-shape CHECK: `published_by_did`, `rkey`, `uri`, `cid`, `rev`, `published_at`, `record_created_at` are all NULL or all NOT NULL.
- Index `(household_id, position)`.
- **No unique name.** Duplicates allowed; quick-add must never error on a name collision.

### `recipe_collection_entry`

| column          | type                 | notes                                                     |
| --------------- | -------------------- | --------------------------------------------------------- |
| `collection_id` | text NOT NULL        | FK → `recipe_collection.id` ON DELETE CASCADE             |
| `household_id`  | text NOT NULL        | part of composite FK below                                |
| `recipe_id`     | text NOT NULL        | part of composite FK below                                |
| `position`      | integer NOT NULL     | dense 0..n-1 per collection; IS the published array order |
| `added_by_did`  | text NOT NULL        | attribution                                               |
| `added_at`      | timestamptz NOT NULL | default now                                               |

- PK `(collection_id, recipe_id)` — a recipe files into a collection at most once.
- **Composite FK `(household_id, recipe_id)` → `household_recipe(household_id, recipe_id)` ON DELETE CASCADE.** This is the `household_recipe_note` trick: only boxed recipes are filable, and removing a recipe from the box auto-unfiles it everywhere (positions still need explicit renumbering — see §5, `removeRecipeFromHousehold`).
- Index `(collection_id, position)`.

Hard delete throughout; no soft-delete (push-only v1, matches `household_recipe`).

Precedents: `src/db/migrations/1785600000000_create_household_recipe_tables.ts` (join + composite-FK child pattern), `1786118073635_create_meal_plan_entry.ts` (dense position). App tables are snake_case.

## 4. atproto write layer — new `src/lib/atproto/collection-writes.ts`

Reuse from `src/lib/atproto/recipe-writes.ts`: `getUserRecipeClient(did)`, `AtprotoScopeError`, and **export `withScopeCheck`** (currently module-private — export it, don't duplicate it).

```ts
// Pure; unit-tested. Empty entries → omit `recipes` (optional in lexicon).
export function buildCollectionRecord(input: {
  name: string;
  description: string | null;
  recipes: Array<{ uri: string; cid: string }>; // already in position order
  createdAt: Date; // record_created_at (frozen)
  updatedAt: Date;
}): ExchangeRecipeCollection.Record;

// createRecord WITHOUT rkey — PDS mints the TID. Parse rkey from result.uri.
export async function createCollectionRecord(did: string, record: ExchangeRecipeCollection.Record): Promise<{ uri: string; cid: string; rkey: string; rev: string }>;

// putRecord with swapRecord: priorCid (CAS). On InvalidSwap, retry ONCE without
// the guard — local DB is source of truth, last-write-wins.
export async function putCollectionRecord(did: string, rkey: string, record: ExchangeRecipeCollection.Record, priorCid: string): Promise<{ uri: string; cid: string; rev: string }>;

// deleteRecord; RecordNotFound = success (idempotent).
export async function deleteCollectionRecord(did: string, rkey: string): Promise<void>;
```

Verified against `@atproto/lex-client@0.3.3` (`client.d.ts`): `createRecord` rkey optional for tid keys; `putRecord`/`deleteRecord` accept `swapRecord`/`swapCommit`.

Generated lexicon types come from `packages/lexicons` — run `pnpm --filter @buttery/lexicons build` before typecheck (generated output is not committed).

## 5. Server functions — new `src/server/collections.ts`

House style: `createServerFn`, dynamic `import()` inside handlers, zod validators, DTOs from `#/lib/api/types`. Authorization via `householdScopedQuery` membership joins plus explicit `assertMember` where a role gate applies.

### Read (member)

- `listCollections({ householdId })` → `CollectionSummary[]`, ordered by `position`. Each summary carries ordered `recipeIds` (from entries by position) and `publishedByHandle` (resolve via `resolveAdderHandles` — **export it** from `src/server/household-recipes.ts:93`, don't duplicate). This is the **single read**: chips on recipe cards, counts, picker state, and the scoped ledger all derive client-side by joining against the already-cached recipes query.

### Member writes

All reorders use the meal-plan §3.6 pattern (`src/server/meal-plan.ts`): `FOR UPDATE` lock on the parent scope, then dense renumber 0..n-1.

- `createCollection({ householdId, name, description? })` → appends at bottom (`position = count`). Returns the new summary.
- `updateCollection({ collectionId, name?, description? })`.
- `reorderCollections({ householdId, orderedIds })` — local-only, never triggers a re-put.
- `reorderCollectionRecipes({ collectionId, orderedRecipeIds })`.
- `addRecipesToCollection({ collectionId, recipeIds, publishRecipeIds? })` — appends at bottom in given order; ignores already-filed ids. **Preflight**: if the target collection is published and any added recipe is unpublished, fail with `{ ok: false, reason: "recipes_unpublished", recipeIds: [...] }` — unless those ids are in `publishRecipeIds`, in which case publish each recipe first (existing recipe-publish path), then file. This is the "Publish recipe & add" combo.
- `removeRecipeFromCollection({ collectionId, recipeId })` — delete + renumber.

### Owner writes (`assertMember(did, householdId, "owner")`)

- `publishCollection({ collectionId })`:
  1. Flag gate: `isAtprotoPublishEnabled(did)` — fail closed.
  2. Preflight: every entry's recipe must be published; else `{ ok: false, reason: "recipes_unpublished", recipeIds }`.
  3. `createCollectionRecord` as the acting owner (they become `published_by_did`).
  4. Stamp all publish columns (including `record_created_at = now`).
     Result union modeled on `SaveRecipeResult` (`ok | flag_disabled | scope_error | recipes_unpublished | publisher_unavailable`).
- `unpublishCollection({ collectionId })` — `deleteCollectionRecord` as publisher, then clear all publish columns, keep local rows. Publisher session unrestorable → `{ ok: false, reason: "publisher_unavailable" }` (no local change).
- `deleteCollection({ collectionId })` — if published: PDS delete **first**, local hard-delete only on success (never silently orphan a live record); then renumber remaining collections. Unpublished: straight delete + renumber.

### Re-put plumbing

```ts
// Called AFTER COMMIT on every write that changes a published collection's
// name/description/membership/within-order. Rebuilds the record from DB state,
// re-puts via getUserRecipeClient(published_by_did) with CAS, updates cid/rev,
// clears record_stale. On ANY failure: set record_stale = true, never throw.
async function reputOrMarkStale(db: Db, collectionId: string): Promise<{ stale: boolean }>;
```

Callers surface `stale: true` as "Saved — couldn't update @handle's published copy yet" with retry (any later successful write clears it; the edit dialog gets an explicit retry button that just re-runs `reputOrMarkStale` via a small `retryCollectionSync` server fn).

### Change to existing code

- `removeRecipeFromHousehold` (`src/server/household-recipes.ts:373`) gains a transaction: collect collections containing the recipe → delete the `household_recipe` row (composite FK cascades the entries) → renumber each affected collection → after commit, `reputOrMarkStale` each affected **published** collection.

## 6. Port layer (offline M1 rules)

- **DTO** `CollectionSummary` in `src/lib/api/types.ts`: `{ id, name, description, position, recipeIds: string[], createdByDid, publishedByDid, publishedByHandle, publishedAt, recordStale, uri }` (publish fields nullable).
- **Key**: `keys.household.collections(householdId)` in `src/lib/api/keys.ts`.
- **Query**: `householdCollectionsQuery(householdId)` factory in `src/lib/api/queries.ts` — presence in this file = offline-readable, which is intended.
- **Transport**: wrappers in `src/lib/api/transport.ts` (`as xFn` aliases, natural-args style; the only module allowed to import `#/server/**`).
- **Mutations**: entries in `mutationKeys` + `optimisticOver` in `src/lib/api/mutations.ts` for update/remove/reorder-collections/reorder-recipes/file/unfile. Pure patch functions live beside the feature in `src/components/collections/optimistic.ts`, unit-tested. Create/publish/unpublish/delete are **non-optimistic** (server assigns ids/positions/publish state).
- All writes online-only (`OFFLINE_WRITE_HINT`).
- Existing DTOs unchanged → **no `CACHE_SCHEMA_VERSION` bump** (`src/lib/offline/partition.ts:33`).

## 7. Routing + UI

Load the `buttery-design-system` and `accessibility-compliance` skills before building UI. shadcn-on-Base-UI vendored components (`render={}` slot pattern — never Radix `asChild`). Native HTML5 DnD only — no dnd-kit.

### URL design

Search params on the **layout route** `src/routes/household.recipes.tsx` (zod `validateSearch` with `.catch` so bad params degrade, never 404):

- `?scope=mine|favorites|recent|unpublished` — smart-row scope. Default (absent): `mine`, A–Z.
- `?c=<collectionId>` — collection scope; wins over `scope` if both present.
- Recipe links carry search through (`from`-typed links); the `$id` detail route tolerates the params. Deep-linking a recipe inside a collection scope composes.
- `?c=` pointing at a deleted collection → inline empty state ("This collection no longer exists"), not a 404.

Column collapse state = cookie, same idiom as the app sidebar; collapsed by default; toggled from the ledger filter bar.

### Scope semantics (all client-side over the two cached queries)

- `mine`: whole box, A–Z by title.
- `recent`: whole box, `addedAt` desc.
- `favorites`: `favorite` only, A–Z.
- `unpublished`: `unpublished` only, A–Z (subsumes the old lock-chip).
- `c=<id>`: entries of that collection, by entry position; drag-reorderable when search is empty.
- Search input filters within the active scope.

### New components — `src/components/collections/`

| file                         | purpose                                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CollectionsColumn.tsx`      | Desktop third column. `hidden md:flex`; also carries the ledger's existing `lg` hide-on-selection classes so it yields to the detail pane like the ledger does.                              |
| `CollectionsSheet.tsx`       | `<md` left Sheet variant of the tree.                                                                                                                                                        |
| `CollectionsTree.tsx`        | Smart rows + collection rows + quick-add; shared by column and sheet.                                                                                                                        |
| `CollectionRow.tsx`          | Name, count, hover gear (opens edit), drag handle (list reorder), drop target (file-to-folder).                                                                                              |
| `QuickAddRow.tsx`            | Inline input; Enter creates + selects, Esc discards. Never errors on duplicate names.                                                                                                        |
| `EditCollectionDialog.tsx`   | Name/description/entries manage + within-collection reorder. Full-height sheet on mobile. Publish section owner-only: "Published by @handle", stale badge + retry, unpublish/delete actions. |
| `PublishConfirmDialog.tsx`   | States record goes to acting owner's PDS and future updates come from @handle regardless of editor.                                                                                          |
| `UnpublishConfirmDialog.tsx` | Warning: deletes the PDS record, keeps local; PDS deletion doesn't guarantee removal from the wider internet.                                                                                |
| `DeleteCollectionDialog.tsx` | Warning: deletes local + PDS copy; same internet caveat. Built on `ConfirmDialog`.                                                                                                           |
| `CollectionChips.tsx`        | Chips on recipe detail showing memberships; tap to open picker.                                                                                                                              |
| `CollectionPickerDialog.tsx` | Checkbox list; blocked rows for private-recipe→published-collection with "Publish recipe & add" action.                                                                                      |
| `AddRecipesSheet.tsx`        | Mobile: add many recipes to one collection; 44px checkbox rows.                                                                                                                              |
| `FileRecipeSheet.tsx`        | Mobile: file one recipe into many collections; 44px checkbox rows.                                                                                                                           |
| `ScopedLedgerHeader.tsx`     | Active scope name, count, clear-scope control above the ledger.                                                                                                                              |
| `optimistic.ts`              | Pure cache patch fns for the mutations in §6.                                                                                                                                                |

### Changed files

- `src/routes/household.recipes.tsx` — mount column/sheet, `validateSearch`, ensure loader also primes `householdCollectionsQuery`.
- `src/components/recipes/RecipeLedger.tsx` — **remove** `SortKey`, the sort `Select`, and the "mine" lock-chip (lines ~93–108; verified it filters `!r.unpublished`). Add: collections toggle in the filter bar, `ScopedLedgerHeader`, scope-aware `filterAndSort`, drag handles + `DropLine` when collection-scoped and search is empty.
- `src/components/recipes/DetailPane.tsx` — `CollectionChips`, mobile "File this recipe" button, and update the **recipe** publish-confirm copy to name @handle (decision 5 applies to recipes too).
- `src/components/AppSidebar.tsx` — delete the Collections `soon` entry (line 30).

### Drag and drop (desktop only)

Native HTML5, existing primitives: `useDragHandle` (`src/lib/hooks/use-drag-source.ts`), `insertionPointAt`/`DropLine` (canonical reorder pattern in `src/components/recipes/create/LineEditor.tsx`). Typed payload `application/x-buttery-recipe` for ledger-card → collection-row filing; a distinct type for collection-row list reorder so the two drags can't cross-drop. Mobile: no drag — sheets are the filing mechanism.

## 8. Edge cases

- Empty published collection is legal (omit `recipes` — verified optional).
- `?c=` to a deleted collection → inline empty state.
- Publisher leaves the household: their stored session usually still restores (re-puts keep working). If not: `record_stale` + "publisher unavailable" surfaces naming @handle. A "transfer publisher" flow is a noted follow-up, not v1.
- Concurrent reorders: FOR UPDATE + dense renumber; db test asserts density invariant under interleaving.
- Duplicate names allowed everywhere.
- Length limits enforced at zod validator + UI maxLength + PDS (which counts graphemes — validator should match lexicon limits exactly).
- Filing an already-filed recipe is a silent no-op (PK conflict → ignore).
- `record_stale` never blocks local edits; it only annotates.

## 9. Tests

- `src/server/collections.db.test.ts` — position density after create/reorder/remove/delete (both tables); composite-FK cascade unfiles on box removal + renumber; authz: non-member rejected everywhere, member rejected on owner fns; publish preflight (`recipes_unpublished`); delete-with-PDS-failure keeps local rows.
- `src/components/collections/optimistic.test.ts` — each patch fn.
- `src/lib/atproto/collection-record.test.ts` — `buildCollectionRecord`: ref order follows input order, empty → `recipes` omitted, description null → `text` omitted, frozen createdAt.
- Validator tests for length limits.
- No DOM tests (repo has none).

## 10. Milestones (each independently reviewable + shippable)

1. **Schema + server core + port layer.** Migration, `collections.ts` (all fns except publish/unpublish/delete-PDS parts — `deleteCollection` local-only for now), DTO/keys/query/transport/mutations, `removeRecipeFromHousehold` transaction, db tests. Inert (no UI reachable).
2. **Desktop UI core.** Column, tree, smart rows replacing sort dropdown + mine-chip, quick-add, scoped ledger + header, edit dialog (sans publish section), chips + picker (sans publish combo), nav-rail removal, URL params.
3. **Drag and drop.** All three surfaces: collections-list reorder, within-collection reorder, ledger-card → collection-row filing.
4. **Mobile.** Sheet tree, `AddRecipesSheet`, `FileRecipeSheet`, full-height edit sheet, 44px targets.
5. **atproto publish.** `collection-writes.ts`, publish/unpublish/delete server parts, `reputOrMarkStale` + retry fn, all confirm dialogs with mandated warning copy, stale badge/retry UI, @handle copy everywhere including the **recipe** publish dialog, "Publish recipe & add" combo, record unit tests.

Per milestone: `pnpm --filter @buttery/lexicons build` before typecheck; run oxlint/oxfmt; log to the results doc.
