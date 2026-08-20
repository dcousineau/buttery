import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import type { Kysely } from "kysely";
import * as z from "zod";
import type { DB } from "#/db/types";
import type { CollectionSummary } from "#/lib/api/types";

/**
 * Collections server functions (collections plan §5).
 *
 * Same shape as `server/meal-plan.ts` and `server/grocery.ts`: every handler
 * resolves the caller DID from the server-validated session, the active
 * household from `session.active_household_id` (NEVER a client argument), and
 * gates through `assertMember` and/or `householdScopedQuery` — the membership
 * check IS the authorization. Every write additionally re-asserts
 * `household_id` in its `WHERE`, so a leaked or guessed `collectionId` from
 * another household is inert.
 *
 * Role is consulted in exactly one place (§2.8): `deleteCollection` is
 * owner-only, because it destroys shared state and — once §5's publish path
 * lands — a record on someone's PDS. Creating, editing, reordering, filing and
 * unfiling are open to every live member. A household organizes together.
 *
 * Server-only imports (`getDb`, kysely `sql`, authz/session) are pulled in with
 * dynamic `import()` inside each handler so this module stays safe to reference
 * from the client bundle.
 *
 * Every server fn below is a thin wrapper — session + `assertMember`, then a
 * plain exported function taking `(db, did, householdId, input)` that holds ALL
 * of the behaviour. That is what lets `collections.db.test.ts` reach the logic
 * without faking a session, and the wrappers stay the only place
 * `active_household_id` is read.
 *
 * **Milestone 1 scope (§10.1).** Everything here is local. `publishCollection`,
 * `unpublishCollection`, the PDS half of `deleteCollection` and the
 * `reputOrMarkStale` re-put plumbing arrive in milestone 5; the exact call
 * sites they attach to are marked `TODO(m5)` below rather than sketched, so the
 * milestone that implements them does not have to go looking.
 */

// --- shared shapes -------------------------------------------------------

/**
 * The wire DTO this module returns is declared in the port's `types.ts` and
 * imported from there (offline plan §4.3 / §7): the client caches these shapes
 * in IndexedDB, versions them, and must be able to name them without importing
 * a server module — so it owns the declaration. Re-exported here for the
 * server-side callers that already reach for it through this module.
 */
export type { CollectionSummary };

/**
 * What filing recipes into a collection can answer, modelled on
 * `SaveRecipeResult` (`server/recipes-write.ts`) rather than on a thrown error:
 * `recipes_unpublished` is a *decision the user has to make*, not a fault, and
 * it needs to travel with the ids so the picker can offer "Publish recipe &
 * add" against exactly those rows (§5, §7).
 */
export type AddRecipesToCollectionResult =
  | { ok: true; added: string[] }
  // The collection is published and at least one of these recipes is not. A
  // published collection may not reference a private recipe (§2.4).
  | { ok: false; reason: "recipes_unpublished"; recipeIds: string[] };

// --- validators ----------------------------------------------------------

/**
 * A collection id. App-minted ULID; the shape is deliberately not asserted (the
 * rule recipe ids follow in `AGENTS.md`) — existence inside the caller's
 * household is the only truth, and every statement re-asserts `household_id`.
 * The cap only keeps a hostile parameter bounded.
 */
const collectionId = z.string().min(1).max(128);

/**
 * A recipe id. Ids are atproto rkeys, so the shape is NOT asserted: a regex
 * would reject real ids. Membership of the caller's box is the only gate.
 */
const recipeId = z.string().min(1).max(512);

/**
 * The lexicon's caps, in the unit the lexicon counts (§1, verified against
 * `packages/lexicons/lexicons/exchange.recipe.collection.json`): `name`
 * maxLength 100, `text` maxLength 1000. atproto `maxLength` on a string is
 * **UTF-8 bytes**, so these are measured in bytes here too — a validator that
 * counted JS characters would accept a name of 100 emoji and then watch the PDS
 * reject the record on publish.
 *
 * The vendored lexicon carries no `maxGraphemes` on either field, so neither
 * does this.
 */
export const COLLECTION_NAME_MAX_BYTES = 100;
export const COLLECTION_DESCRIPTION_MAX_BYTES = 1000;

const utf8 = new TextEncoder();

/** UTF-8 byte length, the unit the lexicon and the PDS both count in. */
function byteLength(value: string): number {
  return utf8.encode(value).length;
}

/**
 * A collection name. Trimmed first, then measured — the over-generous pre-trim
 * cap stops a megabyte of whitespace from reaching the trim, the same guard
 * `meal-plan.ts`'s `noteBody` uses. Empty after trimming is a rejection: the
 * inline quick-add simply discards an empty input rather than calling this.
 *
 * Duplicates are NOT rejected (§8). Two collections may share a name; quick-add
 * must never error on a collision.
 */
export const collectionName = z
  .string()
  .max(COLLECTION_NAME_MAX_BYTES * 8)
  .transform((value) => value.trim())
  .refine((value) => value.length >= 1, { message: "A collection needs a name." })
  .refine((value) => byteLength(value) <= COLLECTION_NAME_MAX_BYTES, { message: `A name is at most ${COLLECTION_NAME_MAX_BYTES} bytes.` });

/**
 * A collection description (`text` in the lexicon). Optional everywhere; an
 * empty string after trimming means "no description" and is stored as NULL, so
 * the record omits the field rather than publishing `""`.
 */
export const collectionDescription = z
  .string()
  .max(COLLECTION_DESCRIPTION_MAX_BYTES * 8)
  .transform((value) => value.trim())
  .refine((value) => byteLength(value) <= COLLECTION_DESCRIPTION_MAX_BYTES, { message: `A description is at most ${COLLECTION_DESCRIPTION_MAX_BYTES} bytes.` })
  .transform((value) => (value === "" ? null : value));

/**
 * 200 is the cap on a single filing gesture. The picker and the mobile "Add
 * recipes" sheet both operate over a household's own box, which is small; the
 * bound only keeps a hostile client from asking for an unbounded renumber.
 */
const RECIPE_LIMIT = 200;

// --- helpers -------------------------------------------------------------

/** The columns every `CollectionSummary` is built from. */
const COLLECTION_COLUMNS = ["id", "name", "description", "position", "created_by_did", "published_by_did", "published_at", "record_stale", "uri"] as const;

interface CollectionRow {
  id: string;
  name: string;
  description: string | null;
  position: number;
  created_by_did: string;
  published_by_did: string | null;
  published_at: Date | string | null;
  record_stale: boolean;
  uri: string | null;
}

/** One row plus its ordered membership and the publisher's handle, as the wire sees it. */
function toSummary(row: CollectionRow, recipeIds: string[], publishedByHandle: string | null): CollectionSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    position: row.position,
    recipeIds,
    createdByDid: row.created_by_did,
    publishedByDid: row.published_by_did,
    publishedByHandle,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    recordStale: row.record_stale,
    uri: row.uri,
  };
}

/**
 * Read one collection, scoped to the household. `undefined` means "not this
 * household's, or gone" — the two are the same answer to a caller and neither
 * may be distinguishable from outside.
 */
async function readCollectionRow(db: Kysely<DB>, householdId: string, id: string): Promise<CollectionRow | undefined> {
  return db.selectFrom("recipe_collection").select(COLLECTION_COLUMNS).where("id", "=", id).where("household_id", "=", householdId).executeTakeFirst();
}

// --- §3 ordering: lock the parent scope, rewrite `position` densely -------
//
// Both orderings follow the planner's §3.6 pattern verbatim (`meal-plan.ts`):
// `SELECT … ORDER BY position FOR UPDATE` on the whole scope, then a dense
// rewrite of `0..n-1` over the ids in the order the caller asked for. The row
// locks are what serialize two household members reordering the same list at
// the same moment; the dense rewrite is what repairs any gap an interrupted
// earlier write left behind.

/** Lock every collection in a household, returning ids in canonical read order. */
async function lockCollections(trx: Kysely<DB>, householdId: string): Promise<string[]> {
  const rows = await trx.selectFrom("recipe_collection").select("id").where("household_id", "=", householdId).orderBy("position").orderBy("created_at").forUpdate().execute();
  return rows.map((row) => row.id);
}

/**
 * Rewrite `position = 0..n-1` over the collection ids in the order given.
 *
 * A loop rather than one `UPDATE … FROM (VALUES …)`, for the reasons
 * `renumberSlot` gives: a household holds a handful of collections, this only
 * ever runs inside the transaction that already holds their locks, and the
 * readable version is the one a future feature can splice an index into.
 * `household_id` is repeated in the predicate so the statement is inert against
 * another household's row even if an id leaked into the list.
 */
async function renumberCollections(trx: Kysely<DB>, householdId: string, ids: string[]): Promise<void> {
  for (let position = 0; position < ids.length; position++) {
    await trx.updateTable("recipe_collection").set({ position }).where("id", "=", ids[position]).where("household_id", "=", householdId).execute();
  }
}

/** Lock every entry of one collection, returning recipe ids in read order. */
async function lockEntries(trx: Kysely<DB>, id: string): Promise<string[]> {
  const rows = await trx.selectFrom("recipe_collection_entry").select("recipe_id").where("collection_id", "=", id).orderBy("position").orderBy("added_at").forUpdate().execute();
  return rows.map((row) => row.recipe_id);
}

/** Rewrite `position = 0..n-1` over one collection's entries. See {@link renumberCollections}. */
async function renumberEntries(trx: Kysely<DB>, id: string, recipeIds: string[]): Promise<void> {
  for (let position = 0; position < recipeIds.length; position++) {
    await trx.updateTable("recipe_collection_entry").set({ position }).where("collection_id", "=", id).where("recipe_id", "=", recipeIds[position]).execute();
  }
}

/**
 * The order a reorder actually applies: the caller's sequence, intersected with
 * what is really there, with anything it failed to mention appended in its
 * existing order.
 *
 * A client's list is a snapshot — someone else may have created or removed a
 * row since it was rendered. Trusting it verbatim would drop the rows it does
 * not know about; rejecting the whole call would make a normal race look like
 * an error. Reconciling instead means the drag lands where it was dropped and
 * the unmentioned rows keep their relative order at the bottom.
 */
function reconcileOrder(present: string[], requested: string[]): string[] {
  const live = new Set(present);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of requested) {
    if (!live.has(id) || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  for (const id of present) if (!seen.has(id)) ordered.push(id);
  return ordered;
}

// --- §5 listCollections --------------------------------------------------

/**
 * Every collection in the household, in `position` order, each carrying its
 * ordered membership.
 *
 * This is the **single** collections read (§5): the chips on a recipe, the
 * counts beside each row, the picker's checkbox state and the scoped ledger all
 * derive client-side from this array joined against the already-cached recipes
 * query. Small N — a household has collections, not a catalogue — so it is one
 * shot with no pagination, exactly like `listHouseholdRecipes`.
 */
export const listCollections = createServerFn({ method: "GET" }).handler(async (): Promise<CollectionSummary[]> => {
  const { getDb } = await import("#/lib/db");
  const { activeContext } = await import("./recipe-context");
  const { did, householdId } = await activeContext();
  return readCollections(getDb(), did, householdId);
});

/**
 * The query behind `listCollections`, callable by an already-authorized
 * server-side reader. Same contract as `readMealPlanWeek`: the caller starts the
 * authorization and `householdScopedQuery` finishes it, so a non-member simply
 * selects nothing.
 */
export async function readCollections(db: Kysely<DB>, did: string, householdId: string): Promise<CollectionSummary[]> {
  const { householdScopedQuery } = await import("./household/scoped-query");
  const { resolveAdderHandles } = await import("./household-recipes");

  const rows = await householdScopedQuery(db, did, householdId)
    .innerJoin("recipe_collection as rc", "rc.household_id", "hm.household_id")
    .select([
      "rc.id as id",
      "rc.name as name",
      "rc.description as description",
      "rc.position as position",
      "rc.created_by_did as created_by_did",
      "rc.published_by_did as published_by_did",
      "rc.published_at as published_at",
      "rc.record_stale as record_stale",
      "rc.uri as uri",
    ])
    // `created_at` breaks the tie the way every other dense-position read does:
    // `position` carries no unique constraint, so two rows can briefly share one
    // between an interrupted write and the next renumber.
    .orderBy("rc.position")
    .orderBy("rc.created_at")
    .execute();
  if (rows.length === 0) return [];

  // Membership in one round-trip, grouped by collection. The rows arrive in
  // position order, so pushing straight into the bucket preserves it.
  const ids = rows.map((row) => row.id);
  const entries = await db
    .selectFrom("recipe_collection_entry")
    .select(["collection_id", "recipe_id"])
    .where("collection_id", "in", ids)
    .orderBy("position")
    .orderBy("added_at")
    .execute();
  const recipeIdsByCollection = new Map<string, string[]>();
  for (const entry of entries) {
    const bucket = recipeIdsByCollection.get(entry.collection_id) ?? [];
    bucket.push(entry.recipe_id);
    recipeIdsByCollection.set(entry.collection_id, bucket);
  }

  // The publisher's "@handle" — the same batched two-table lookup the box uses
  // for adder attribution, reused rather than copied (§5).
  const handleByDid = await resolveAdderHandles(db, [...new Set(rows.map((row) => row.published_by_did).filter((value): value is string => value !== null))]);

  return rows.map((row) => toSummary(row, recipeIdsByCollection.get(row.id) ?? [], row.published_by_did ? (handleByDid.get(row.published_by_did) ?? null) : null));
}

// --- §5 createCollection -------------------------------------------------

/**
 * Create a collection, appended to the bottom of the household's list (§2.1).
 *
 * Never fails on a duplicate name (§8) — there is no unique constraint to hit,
 * because the quick-add row has nowhere sensible to show an error.
 */
export const createCollection = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ name: collectionName, description: collectionDescription.optional() }).parse(data))
  .handler(async ({ data }): Promise<CollectionSummary> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return insertCollection(getDb(), did, householdId, data);
  });

/** The body of `createCollection`. See `readCollections` for the contract. */
export const insertCollection = createServerOnlyFn(
  async (db: Kysely<DB>, did: string, householdId: string, input: { name: string; description?: string | null }): Promise<CollectionSummary> => {
    const { ulid } = await import("./household/ids");
    const id = ulid();

    return db.transaction().execute(async (trx) => {
      // The lock is what stops two members creating a collection at the same
      // moment from claiming the same tail position.
      const existing = await lockCollections(trx, householdId);
      const row = await trx
        .insertInto("recipe_collection")
        .values({
          id,
          household_id: householdId,
          name: input.name,
          description: input.description ?? null,
          position: existing.length,
          created_by_did: did,
        })
        .returning(COLLECTION_COLUMNS)
        .executeTakeFirstOrThrow();
      // The append is already dense; the rewrite also repairs any gap an
      // interrupted earlier write left behind in this household.
      await renumberCollections(trx, householdId, existing.concat([id]));
      return toSummary(row, [], null);
    });
  },
);

// --- §5 updateCollection -------------------------------------------------

/**
 * Rename a collection and/or rewrite its description. Both fields are optional;
 * an omitted one is left alone, and `description: null` clears it.
 */
export const updateCollection = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ collectionId, name: collectionName.optional(), description: collectionDescription.nullable().optional() }).parse(data))
  .handler(async ({ data }): Promise<{ updated: boolean }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return patchCollection(getDb(), householdId, data);
  });

/** The body of `updateCollection`. See `readCollections` for the contract. */
export async function patchCollection(
  db: Kysely<DB>,
  householdId: string,
  input: { collectionId: string; name?: string; description?: string | null },
): Promise<{ updated: boolean }> {
  const { sql } = await import("kysely");

  const patch: { name?: string; description?: string | null } = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  // "Change nothing" is a successful no-op, not an empty UPDATE statement.
  if (Object.keys(patch).length === 0) return { updated: false };

  const updated = await db
    .updateTable("recipe_collection")
    .set({ ...patch, updated_at: sql`now()` })
    .where("id", "=", input.collectionId)
    .where("household_id", "=", householdId)
    .returning("id")
    .executeTakeFirst();

  // TODO(m5): reputOrMarkStale(db, input.collectionId) — name/description are
  // published fields, so a published collection needs its record re-put here,
  // after the write has committed.
  return { updated: Boolean(updated) };
}

// --- §5 reorderCollections -----------------------------------------------

/**
 * Reorder the household's collection list. **Local-only** (§2.10): this order is
 * never published, so it never triggers a re-put — the one write in this module
 * that cannot make a record stale.
 */
export const reorderCollections = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ orderedIds: z.array(collectionId).max(500) }).parse(data))
  .handler(async ({ data }): Promise<{ reordered: boolean }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return orderCollections(getDb(), householdId, data);
  });

/** The body of `reorderCollections`. See `readCollections` for the contract. */
export async function orderCollections(db: Kysely<DB>, householdId: string, input: { orderedIds: string[] }): Promise<{ reordered: boolean }> {
  return db.transaction().execute(async (trx) => {
    const present = await lockCollections(trx, householdId);
    if (present.length === 0) return { reordered: false };
    await renumberCollections(trx, householdId, reconcileOrder(present, input.orderedIds));
    return { reordered: true };
  });
}

// --- §5 reorderCollectionRecipes -----------------------------------------

/**
 * Reorder the recipes inside one collection. Unlike the list order, this one IS
 * published — it is the order of the record's `recipes` array (§2.10).
 */
export const reorderCollectionRecipes = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ collectionId, orderedRecipeIds: z.array(recipeId).max(RECIPE_LIMIT) }).parse(data))
  .handler(async ({ data }): Promise<{ reordered: boolean }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return orderCollectionRecipes(getDb(), householdId, data);
  });

/** The body of `reorderCollectionRecipes`. See `readCollections` for the contract. */
export async function orderCollectionRecipes(db: Kysely<DB>, householdId: string, input: { collectionId: string; orderedRecipeIds: string[] }): Promise<{ reordered: boolean }> {
  const { sql } = await import("kysely");

  const reordered = await db.transaction().execute(async (trx) => {
    // The household scope is re-asserted before anything is locked, so an id
    // from another household never even takes a lock.
    const collection = await readCollectionRow(trx, householdId, input.collectionId);
    if (!collection) return false;

    const present = await lockEntries(trx, input.collectionId);
    if (present.length === 0) return false;
    await renumberEntries(trx, input.collectionId, reconcileOrder(present, input.orderedRecipeIds));
    await trx
      .updateTable("recipe_collection")
      .set({ updated_at: sql`now()` })
      .where("id", "=", input.collectionId)
      .where("household_id", "=", householdId)
      .execute();
    return true;
  });

  // TODO(m5): reputOrMarkStale(db, input.collectionId) when `reordered` — the
  // entry order IS the published array order.
  return { reordered };
}

// --- §5 addRecipesToCollection -------------------------------------------

/**
 * File recipes into a collection, appended at the bottom in the order given.
 *
 * Already-filed ids are ignored rather than moved: filing something twice is a
 * silent no-op (§8), and the PK makes that structural. Unboxed ids fail the
 * whole call instead of being dropped, mirroring `addRecipesToPlan` — the client
 * never half-succeeds, and the composite FK would refuse them anyway.
 */
export const addRecipesToCollection = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ collectionId, recipeIds: z.array(recipeId).min(1).max(RECIPE_LIMIT) }).parse(data))
  .handler(async ({ data }): Promise<AddRecipesToCollectionResult> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return fileRecipesIntoCollection(getDb(), did, householdId, data);
  });

/** The body of `addRecipesToCollection`. See `readCollections` for the contract. */
export const fileRecipesIntoCollection = createServerOnlyFn(
  async (db: Kysely<DB>, did: string, householdId: string, input: { collectionId: string; recipeIds: string[] }): Promise<AddRecipesToCollectionResult> => {
    const { sql } = await import("kysely");

    const collection = await readCollectionRow(db, householdId, input.collectionId);
    if (!collection) throw new Error("That collection no longer exists.");

    // Distinct, order-preserving: the caller may legitimately repeat an id, but
    // it files once.
    const wanted = [...new Set(input.recipeIds)];

    const boxed = await db.selectFrom("household_recipe").select("recipe_id").where("household_id", "=", householdId).where("recipe_id", "in", wanted).execute();
    const inBox = new Set(boxed.map((row) => row.recipe_id));
    if (wanted.some((id) => !inBox.has(id))) throw new Error("That recipe is not in this household's box.");

    // §2.4 preflight: a published collection may not point at a private recipe.
    // `unpublished` is spelled exactly as the ledger spells it — no atproto uri,
    // or a recipe that is not public.
    if (collection.published_by_did) {
      const unpublished = await db
        .selectFrom("recipe")
        .select("id")
        .where("id", "in", wanted)
        .where((eb) => eb.or([eb("visibility", "!=", "public"), eb("uri", "is", null)]))
        .execute();
      if (unpublished.length > 0) {
        // TODO(m5): `publishRecipeIds` — the "Publish recipe & add" combo (§5)
        // publishes each named id through the existing recipe-publish path here
        // and then falls through to the filing below, instead of returning.
        return { ok: false, reason: "recipes_unpublished", recipeIds: unpublished.map((row) => row.id) };
      }
    }

    const added = await db.transaction().execute(async (trx) => {
      const existing = await lockEntries(trx, input.collectionId);
      const filed = new Set(existing);
      const fresh = wanted.filter((id) => !filed.has(id));
      if (fresh.length === 0) return [];

      let position = existing.length;
      for (const id of fresh) {
        await trx
          .insertInto("recipe_collection_entry")
          .values({ collection_id: input.collectionId, household_id: householdId, recipe_id: id, position, added_by_did: did })
          // Belt and braces against a concurrent filing of the same recipe:
          // the PK already makes a double file impossible, and `do nothing`
          // makes it silent rather than an error (§8).
          .onConflict((oc) => oc.columns(["collection_id", "recipe_id"]).doNothing())
          .execute();
        position += 1;
      }
      // The appends are already dense; the rewrite also repairs any gap an
      // interrupted earlier write left behind in this collection.
      await renumberEntries(trx, input.collectionId, existing.concat(fresh));
      await trx
        .updateTable("recipe_collection")
        .set({ updated_at: sql`now()` })
        .where("id", "=", input.collectionId)
        .where("household_id", "=", householdId)
        .execute();
      return fresh;
    });

    // TODO(m5): reputOrMarkStale(db, input.collectionId) when `added.length` —
    // membership changed, so the published record's `recipes` array has to be
    // rebuilt and re-put.
    return { ok: true, added };
  },
);

// --- §5 removeRecipeFromCollection ---------------------------------------

/**
 * Unfile one recipe from one collection, closing the hole its position left.
 * Idempotent: unfiling something already gone reports `{ removed: false }`
 * rather than throwing, so a double-click cannot produce an error toast.
 */
export const removeRecipeFromCollection = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ collectionId, recipeId }).parse(data))
  .handler(async ({ data }): Promise<{ removed: boolean }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return unfileRecipeFromCollection(getDb(), householdId, data);
  });

/** The body of `removeRecipeFromCollection`. See `readCollections` for the contract. */
export async function unfileRecipeFromCollection(db: Kysely<DB>, householdId: string, input: { collectionId: string; recipeId: string }): Promise<{ removed: boolean }> {
  const { sql } = await import("kysely");

  const removed = await db.transaction().execute(async (trx) => {
    const collection = await readCollectionRow(trx, householdId, input.collectionId);
    if (!collection) return false;

    const present = await lockEntries(trx, input.collectionId);
    if (!present.includes(input.recipeId)) return false;

    await trx.deleteFrom("recipe_collection_entry").where("collection_id", "=", input.collectionId).where("recipe_id", "=", input.recipeId).execute();
    await renumberEntries(
      trx,
      input.collectionId,
      present.filter((id) => id !== input.recipeId),
    );
    await trx
      .updateTable("recipe_collection")
      .set({ updated_at: sql`now()` })
      .where("id", "=", input.collectionId)
      .where("household_id", "=", householdId)
      .execute();
    return true;
  });

  // TODO(m5): reputOrMarkStale(db, input.collectionId) when `removed`.
  return { removed };
}

// --- §5 deleteCollection (owner) -----------------------------------------

/**
 * Delete a collection outright. **Owner-only** (§2.8): it destroys shared state
 * for everyone, and — once milestone 5 lands — a record on someone's PDS.
 *
 * Hard delete; the entries cascade. The remaining collections are renumbered so
 * the list stays dense.
 *
 * Idempotent: deleting one that is already gone reports `{ deleted: false }`.
 */
export const deleteCollection = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ collectionId }).parse(data))
  .handler(async ({ data }): Promise<{ deleted: boolean }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId, "owner");
    return removeCollection(getDb(), householdId, data);
  });

/** The body of `deleteCollection`. See `readCollections` for the contract. */
export async function removeCollection(db: Kysely<DB>, householdId: string, input: { collectionId: string }): Promise<{ deleted: boolean }> {
  const collection = await readCollectionRow(db, householdId, input.collectionId);
  if (!collection) return { deleted: false };

  // TODO(m5): a PUBLISHED collection deletes from the PDS FIRST
  // (`deleteCollectionRecord` as `published_by_did`), and the local rows go only
  // on success — never silently orphan a live record (§5). Milestone 1 has no
  // publish path, so no row here can carry publish state yet.

  return db.transaction().execute(async (trx) => {
    const present = await lockCollections(trx, householdId);
    const deleted = await trx.deleteFrom("recipe_collection").where("id", "=", input.collectionId).where("household_id", "=", householdId).returning("id").executeTakeFirst();
    if (!deleted) return { deleted: false };
    await renumberCollections(
      trx,
      householdId,
      present.filter((id) => id !== input.collectionId),
    );
    return { deleted: true };
  });
}

// --- §5 the box-removal hook ---------------------------------------------

/**
 * Renumber every collection a recipe was just unfiled from.
 *
 * The composite FK does the unfiling itself — deleting the `household_recipe`
 * row cascades the entries away — but a cascade leaves holes in `position`, and
 * a hole is what makes the published array order disagree with the local one.
 * So `removeRecipeFromHousehold` (`server/household-recipes.ts`) collects the
 * affected collection ids, deletes the box row, and calls this inside the same
 * transaction.
 *
 * `collectionIds` must be sorted by the caller and the entry locks are taken in
 * that order, so two members removing two recipes that share collections queue
 * up instead of deadlocking each other.
 */
export async function renumberAfterUnfile(trx: Kysely<DB>, collectionIds: string[]): Promise<void> {
  for (const id of collectionIds) {
    await renumberEntries(trx, id, await lockEntries(trx, id));
  }
}

/**
 * The collections a recipe is filed in, sorted — the lock order
 * {@link renumberAfterUnfile} relies on, and the list of records milestone 5
 * has to re-put once the box removal commits.
 */
export async function collectionsHoldingRecipe(db: Kysely<DB>, householdId: string, id: string): Promise<string[]> {
  const rows = await db
    .selectFrom("recipe_collection_entry")
    .select("collection_id")
    .where("household_id", "=", householdId)
    .where("recipe_id", "=", id)
    .orderBy("collection_id")
    .execute();
  return rows.map((row) => row.collection_id);
}
