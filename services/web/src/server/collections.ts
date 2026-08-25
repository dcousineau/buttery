import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import type { Kysely } from "kysely";
import * as z from "zod";
import type { DB } from "#/db/types";
import type { CollectionSummary } from "#/lib/api/types";
import type { SaveRecipeResult } from "./recipes-write";

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
 * Role is consulted in exactly three places (§2.8): `publishCollection`,
 * `unpublishCollection` and `deleteCollection` are owner-only, because each one
 * creates or destroys a record on someone's PDS. Creating, editing, reordering,
 * filing, unfiling and retrying a failed sync are open to every live member. A
 * household organizes together.
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
 * **Milestone 5 (§10.5)** added the PDS half: `publishCollection`,
 * `unpublishCollection`, the PDS-first ordering inside `deleteCollection`, the
 * `reputOrMarkStale` re-put plumbing every membership/name/order write now ends
 * with, and `retryCollectionSync`. The rule that shapes all of it: **the local
 * database is the source of truth and the record is a projection of it**, so a
 * PDS failure after a local write is an annotation (`record_stale`), never a
 * rollback and never an exception — while a PDS failure *before* a destructive
 * local write (unpublish, delete) aborts, so a live record can never be
 * orphaned by rows that no longer exist to point at it.
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
  // `stale` is the re-put's verdict, not the filing's: the entries ARE saved.
  // True means the published copy on the publisher's PDS is behind, which the
  // caller shows as "Saved — couldn't update @handle's published copy yet".
  | { ok: true; added: string[]; stale: boolean }
  // The collection is published and at least one of these recipes is not. A
  // published collection may not reference a private recipe (§2.4). The ids are
  // the ones still blocking — anything the caller listed in `publishRecipeIds`
  // has already been published and is absent from here.
  | { ok: false; reason: "recipes_unpublished"; recipeIds: string[] }
  // Only reachable through the "Publish recipe & add" combo: publishing the
  // recipe hit the kill switch, or an under-scoped grant. Nothing was filed.
  | { ok: false; reason: "flag_disabled" }
  | { ok: false; reason: "scope_error"; missingScope: string | null };

/**
 * The two ways a PDS write can refuse that the UI has to tell apart, shared by
 * every owner write below.
 *
 * `scope_error` is recoverable by the acting user: their atproto grant predates
 * `repo:exchange.recipe.collection`, and re-authorizing fixes it. That is the
 * same `AtprotoScopeError` → `reauth_required` translation the recipe publish
 * path makes (`server/recipes-write.ts`).
 *
 * `publisher_unavailable` is everything else: the publisher's stored OAuth
 * session would not restore, their PDS is down, the network is gone. It carries
 * the publisher's `@handle` because the message a member needs names a *person*
 * — "we couldn't reach @sam's PDS" — and the acting member may not be the
 * publisher at all (§2.5). It is deliberately not split further: from a
 * caller's seat every one of those failures has the same shape (nothing
 * changed, try again later), and inventing finer reasons would invent UI
 * copy that cannot be acted on differently.
 */
export type CollectionPdsFailure = { ok: false; reason: "scope_error"; missingScope: string | null } | { ok: false; reason: "publisher_unavailable"; handle: string | null };

/**
 * What publishing a collection can answer (§5), modelled on `SaveRecipeResult`.
 * Publishing an already-published collection is a successful no-op rather than
 * an error — the same idempotence `runPublishExisting` gives a recipe.
 */
export type PublishCollectionResult =
  | { ok: true; uri: string; publishedByDid: string; publishedByHandle: string | null }
  // The atproto-publishing kill switch is off for this DID (fail-closed §2.3).
  | { ok: false; reason: "flag_disabled" }
  // Every member recipe must be published first (§2.4).
  | { ok: false; reason: "recipes_unpublished"; recipeIds: string[] }
  | CollectionPdsFailure;

/**
 * What unpublishing can answer. `unpublished: false` means there was nothing
 * published to remove — idempotent, not an error. A PDS failure leaves the local
 * publish columns exactly as they were: the record may still be live, and
 * forgetting the rkey would strand it forever.
 */
export type UnpublishCollectionResult = { ok: true; unpublished: boolean } | CollectionPdsFailure;

/**
 * What deleting can answer. On a published collection the PDS delete runs FIRST
 * and the local rows go only if it succeeded (§5) — so a failure here means
 * nothing was deleted at all, anywhere.
 */
export type DeleteCollectionResult = { ok: true; deleted: boolean } | CollectionPdsFailure;

/**
 * Publish one already-saved recipe, as `addRecipesToCollection`'s "Publish
 * recipe & add" combo (§5) does it.
 *
 * A seam, not an abstraction: the default is the real `publishRecipe` server fn
 * and every caller in the app uses it. It exists as a parameter because the db
 * suite drives the exported bodies with no session, and the recipe publish path
 * resolves its own session — so a test that wants to exercise the combo has to
 * be able to stand in for it.
 */
export type RecipePublisher = (recipeId: string) => Promise<SaveRecipeResult>;

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

/** Everything a record build or a PDS write needs about one collection. */
interface PublishRow {
  id: string;
  name: string;
  description: string | null;
  updated_at: Date | string;
  published_by_did: string | null;
  rkey: string | null;
  uri: string | null;
  cid: string | null;
  record_created_at: Date | string | null;
}

const PUBLISH_COLUMNS = ["id", "name", "description", "updated_at", "published_by_did", "rkey", "uri", "cid", "record_created_at"] as const;

/** {@link readCollectionRow}, with the publish state a PDS write needs. */
async function readPublishRow(db: Kysely<DB>, householdId: string, id: string): Promise<PublishRow | undefined> {
  return db.selectFrom("recipe_collection").select(PUBLISH_COLUMNS).where("id", "=", id).where("household_id", "=", householdId).executeTakeFirst();
}

/**
 * One collection's membership in published-array order, each entry carrying the
 * strongRef fields of its recipe.
 *
 * `uri`/`cid` are null for a recipe that is not published — which is what makes
 * this one query answer both questions the publish path asks: "may this
 * collection be published at all?" (any null ⇒ no, §2.4) and "what refs go in
 * the record?".
 */
async function entryRefs(db: Kysely<DB>, collectionId: string): Promise<Array<{ recipeId: string; uri: string | null; cid: string | null }>> {
  const rows = await db
    .selectFrom("recipe_collection_entry as e")
    .innerJoin("recipe as r", "r.id", "e.recipe_id")
    .select(["e.recipe_id as recipe_id", "r.uri as uri", "r.cid as cid", "r.visibility as visibility"])
    .where("e.collection_id", "=", collectionId)
    .orderBy("e.position")
    .orderBy("e.added_at")
    .execute();
  // A public recipe with no cid cannot be a strongRef, so it counts as
  // unpublished here even though the ledger would call it published: the
  // lexicon requires BOTH halves of the ref, and half a ref is not a record.
  return rows.map((row) => ({
    recipeId: row.recipe_id,
    uri: row.visibility === "public" ? row.uri : null,
    cid: row.visibility === "public" ? row.cid : null,
  }));
}

/** The ids among `refs` that cannot be published — see {@link entryRefs}. */
function unpublishedAmong(refs: Array<{ recipeId: string; uri: string | null; cid: string | null }>): string[] {
  return refs.filter((ref) => !ref.uri || !ref.cid).map((ref) => ref.recipeId);
}

/**
 * Which of `recipeIds` are not publishable as a strongRef, in the caller's
 * order. The filing preflight's half of {@link entryRefs}: same definition of
 * "published" (public, with both halves of the ref), asked of recipes that are
 * not entries yet.
 */
async function unpublishedRecipeIds(db: Kysely<DB>, recipeIds: string[]): Promise<string[]> {
  if (recipeIds.length === 0) return [];
  const rows = await db
    .selectFrom("recipe")
    .select("id")
    .where("id", "in", recipeIds)
    .where((eb) => eb.or([eb("visibility", "!=", "public"), eb("uri", "is", null), eb("cid", "is", null)]))
    .execute();
  const blocked = new Set(rows.map((row) => row.id));
  return recipeIds.filter((id) => blocked.has(id));
}

/** "@handle" for one DID, or null. The same batched lookup the read uses. */
async function handleFor(db: Kysely<DB>, did: string): Promise<string | null> {
  const { resolveAdderHandles } = await import("./household-recipes");
  return (await resolveAdderHandles(db, [did])).get(did) ?? null;
}

/**
 * Classify a failed PDS write for a caller. See {@link CollectionPdsFailure}
 * for why there are exactly two answers.
 */
async function pdsFailure(db: Kysely<DB>, err: unknown, publisherDid: string): Promise<CollectionPdsFailure> {
  const { AtprotoScopeError } = await import("#/lib/atproto/recipe-writes");
  if (err instanceof AtprotoScopeError) return { ok: false, reason: "scope_error", missingScope: err.missingScope };
  console.warn(`[collections] PDS write as ${publisherDid} failed`, err);
  return { ok: false, reason: "publisher_unavailable", handle: await handleFor(db, publisherDid) };
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

// --- §5 the re-put plumbing ----------------------------------------------

/**
 * Rebuild a published collection's record from the database and put it back on
 * the publisher's PDS. **Called AFTER COMMIT** by every write that changes a
 * published field — name, description, membership, within-collection order.
 *
 * Three properties this function must have, all of them load-bearing:
 *
 * 1. **It never throws.** The local write already committed and is the truth;
 *    failing the caller's mutation because a PDS was unreachable would undo a
 *    save the user watched succeed. Every failure — session gone, PDS down,
 *    under-scoped grant, CAS lost twice — lands in the same place: `record_stale
 *    = true`, and `{ stale: true }` for the caller to annotate with.
 * 2. **`record_stale` is self-healing.** Any later successful re-put clears it,
 *    so the flag is "the copy is behind", not "this collection is broken". The
 *    edit dialog's retry button is just `retryCollectionSync` re-running this.
 * 3. **It writes as `published_by_did`, not as the acting member** (§2.5). The
 *    record lives in the publisher's repo; a household-mate's edit travels
 *    through the publisher's stored OAuth session or not at all.
 *
 * Unpublished collections are the common case and cost one SELECT: there is no
 * record to put, so this is a no-op rather than a caller's `if`.
 *
 * No household scope: the callers are already-authorized writes naming a
 * collection they just wrote, and `retryCollectionSync` re-asserts the scope
 * itself before calling in.
 */
export async function reputOrMarkStale(db: Kysely<DB>, collectionId: string): Promise<{ stale: boolean }> {
  try {
    const row = await db.selectFrom("recipe_collection").select(PUBLISH_COLUMNS).where("id", "=", collectionId).executeTakeFirst();
    // Not published (or gone) ⇒ nothing to keep in step. The all-or-none CHECK
    // means one null here implies the rest, but they are checked individually
    // because that is what narrows the types for the build below.
    if (!row?.published_by_did || !row.rkey || !row.cid || !row.record_created_at) return { stale: false };

    const { buildCollectionRecord, putCollectionRecord } = await import("#/lib/atproto/collection-writes");
    const refs = entryRefsToStrongRefs(await entryRefs(db, collectionId));
    const record = buildCollectionRecord({
      name: row.name,
      description: row.description,
      recipes: refs,
      // The record's own createdAt is frozen at first publish and replayed here;
      // updatedAt is the row's, which the caller's write just bumped.
      createdAt: new Date(row.record_created_at),
      updatedAt: new Date(row.updated_at),
    });

    const put = await putCollectionRecord(row.published_by_did, row.rkey, record, row.cid);
    await db.updateTable("recipe_collection").set({ uri: put.uri, cid: put.cid, rev: put.rev, record_stale: false }).where("id", "=", collectionId).execute();
    return { stale: false };
  } catch (err) {
    console.warn(`[collections] re-put of ${collectionId} failed; marking the record stale`, err);
    // Even the bookkeeping is best-effort: if the database is what broke, the
    // caller's write is still committed and still must not fail.
    await db
      .updateTable("recipe_collection")
      .set({ record_stale: true })
      .where("id", "=", collectionId)
      .execute()
      .catch((markErr: unknown) => console.warn(`[collections] could not mark ${collectionId} stale`, markErr));
    return { stale: true };
  }
}

/**
 * Entry refs → the record's `recipes` array.
 *
 * An entry whose recipe is not published is dropped rather than published as a
 * half-ref: the preflight (§2.4) makes that unreachable through the app, and a
 * lexicon `strongRef` has no spelling for "a recipe I can't name". The local
 * membership stays the truth either way.
 */
function entryRefsToStrongRefs(refs: Array<{ uri: string | null; cid: string | null }>): Array<{ uri: string; cid: string }> {
  const out: Array<{ uri: string; cid: string }> = [];
  for (const ref of refs) if (ref.uri && ref.cid) out.push({ uri: ref.uri, cid: ref.cid });
  return out;
}

/**
 * Re-put every published collection in `collectionIds`, reporting the ones that
 * came back stale. Used by the box-removal sweep (§2.11), which can touch
 * several collections at once.
 */
export async function reputEach(db: Kysely<DB>, collectionIds: string[]): Promise<string[]> {
  const stale: string[] = [];
  for (const id of collectionIds) {
    if ((await reputOrMarkStale(db, id)).stale) stale.push(id);
  }
  return stale;
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
  .handler(async ({ data }): Promise<{ updated: boolean; stale: boolean }> => {
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
): Promise<{ updated: boolean; stale: boolean }> {
  const { sql } = await import("kysely");

  const patch: { name?: string; description?: string | null } = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  // "Change nothing" is a successful no-op, not an empty UPDATE statement.
  if (Object.keys(patch).length === 0) return { updated: false, stale: false };

  const updated = await db
    .updateTable("recipe_collection")
    .set({ ...patch, updated_at: sql`now()` })
    .where("id", "=", input.collectionId)
    .where("household_id", "=", householdId)
    .returning("id")
    .executeTakeFirst();

  // Name and description are both published fields, so the record follows the
  // row — after the UPDATE has committed, and never at the cost of failing it.
  if (!updated) return { updated: false, stale: false };
  const { stale } = await reputOrMarkStale(db, input.collectionId);
  return { updated: true, stale };
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
  .handler(async ({ data }): Promise<{ reordered: boolean; stale: boolean }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return orderCollectionRecipes(getDb(), householdId, data);
  });

/** The body of `reorderCollectionRecipes`. See `readCollections` for the contract. */
export async function orderCollectionRecipes(
  db: Kysely<DB>,
  householdId: string,
  input: { collectionId: string; orderedRecipeIds: string[] },
): Promise<{ reordered: boolean; stale: boolean }> {
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

  // The entry order IS the published array order (§2.10), so a reorder is a
  // record change like any other.
  if (!reordered) return { reordered: false, stale: false };
  const { stale } = await reputOrMarkStale(db, input.collectionId);
  return { reordered: true, stale };
}

// --- §5 addRecipesToCollection -------------------------------------------

/**
 * File recipes into a collection, appended at the bottom in the order given.
 *
 * Already-filed ids are ignored rather than moved: filing something twice is a
 * silent no-op (§8), and the PK makes that structural. Unboxed ids fail the
 * whole call instead of being dropped, mirroring `addRecipesToPlan` — the client
 * never half-succeeds, and the composite FK would refuse them anyway.
 *
 * `publishRecipeIds` is the **"Publish recipe & add" combo** (§5): the ids the
 * user has explicitly agreed to publish first. They are published through the
 * ordinary recipe publish path and then filed in the same call. Consent is
 * per-id and never inferred — an unpublished id that is not on this list still
 * blocks the whole filing with `recipes_unpublished`.
 */
export const addRecipesToCollection = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z.object({ collectionId, recipeIds: z.array(recipeId).min(1).max(RECIPE_LIMIT), publishRecipeIds: z.array(recipeId).max(RECIPE_LIMIT).optional() }).parse(data),
  )
  .handler(async ({ data }): Promise<AddRecipesToCollectionResult> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return fileRecipesIntoCollection(getDb(), did, householdId, data);
  });

/**
 * Publish one recipe the way the app does: the existing `publishRecipe` server
 * fn, session, authorization, kill switch and all. Called server-side from
 * inside another handler, which is the same local execution SSR loaders use.
 */
const publishRecipeThroughApp: RecipePublisher = async (id) => {
  const { publishRecipe } = await import("./recipes-write");
  return publishRecipe({ data: { recipeId: id } });
};

/** The body of `addRecipesToCollection`. See `readCollections` for the contract. */
export const fileRecipesIntoCollection = createServerOnlyFn(
  async (
    db: Kysely<DB>,
    did: string,
    householdId: string,
    input: { collectionId: string; recipeIds: string[]; publishRecipeIds?: string[] },
    publishRecipe: RecipePublisher = publishRecipeThroughApp,
  ): Promise<AddRecipesToCollectionResult> => {
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
    if (collection.published_by_did) {
      const unpublished = await unpublishedRecipeIds(db, wanted);
      const consented = new Set(input.publishRecipeIds ?? []);
      const blocked = unpublished.filter((id) => !consented.has(id));
      // Anything the user did not agree to publish stops the whole filing, so
      // the picker can offer "Publish recipe & add" against exactly these rows.
      if (blocked.length > 0) return { ok: false, reason: "recipes_unpublished", recipeIds: blocked };

      // The combo (§5): publish first, then fall through to the filing below.
      // Sequential on purpose — each publish is a PDS write, and a failure must
      // stop the run rather than fire N more of them.
      for (const id of unpublished) {
        const result = await publishRecipe(id);
        if (result.status === "ok" && result.published) continue;
        // The recipe publish path's refusals, mapped onto this call's union.
        // Anything else (invalid draft, duplicate source URL) leaves the recipe
        // unpublished, which is exactly what `recipes_unpublished` says — now
        // about the one id that failed, since the rest may have published.
        if (result.status === "publish_disabled") return { ok: false, reason: "flag_disabled" };
        if (result.status === "reauth_required") return { ok: false, reason: "scope_error", missingScope: result.missingScope };
        return { ok: false, reason: "recipes_unpublished", recipeIds: [id] };
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

    // Membership changed ⇒ the record's `recipes` array has to be rebuilt.
    if (added.length === 0) return { ok: true, added, stale: false };
    const { stale } = await reputOrMarkStale(db, input.collectionId);
    return { ok: true, added, stale };
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
  .handler(async ({ data }): Promise<{ removed: boolean; stale: boolean }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return unfileRecipeFromCollection(getDb(), householdId, data);
  });

/** The body of `removeRecipeFromCollection`. See `readCollections` for the contract. */
export async function unfileRecipeFromCollection(
  db: Kysely<DB>,
  householdId: string,
  input: { collectionId: string; recipeId: string },
): Promise<{ removed: boolean; stale: boolean }> {
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

  if (!removed) return { removed: false, stale: false };
  const { stale } = await reputOrMarkStale(db, input.collectionId);
  return { removed: true, stale };
}

// --- §5 deleteCollection (owner) -----------------------------------------

/**
 * Delete a collection outright — local rows AND the published record (§2.7).
 * **Owner-only** (§2.8): it destroys shared state for everyone and a record on
 * someone's PDS.
 *
 * Hard delete; the entries cascade. The remaining collections are renumbered so
 * the list stays dense.
 *
 * Idempotent: deleting one that is already gone reports `{ ok: true, deleted:
 * false }`.
 */
export const deleteCollection = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ collectionId }).parse(data))
  .handler(async ({ data }): Promise<DeleteCollectionResult> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId, "owner");
    return removeCollection(getDb(), householdId, data);
  });

/** The body of `deleteCollection`. See `readCollections` for the contract. */
export async function removeCollection(db: Kysely<DB>, householdId: string, input: { collectionId: string }): Promise<DeleteCollectionResult> {
  const collection = await readPublishRow(db, householdId, input.collectionId);
  if (!collection) return { ok: true, deleted: false };

  // A PUBLISHED collection leaves the PDS FIRST, and the local rows go only if
  // that succeeded (§5). The other order would orphan a live record: the rkey
  // and the publisher's DID live in the row we are about to destroy, so a failed
  // delete after a successful one is unrecoverable — nothing would be left that
  // knows what to remove. The user is told to retry instead, and both dialogs
  // already say a PDS delete does not guarantee removal from the wider internet.
  if (collection.published_by_did && collection.rkey) {
    const { deleteCollectionRecord } = await import("#/lib/atproto/collection-writes");
    try {
      await deleteCollectionRecord(collection.published_by_did, collection.rkey);
    } catch (err) {
      return pdsFailure(db, err, collection.published_by_did);
    }
  }

  return db.transaction().execute(async (trx): Promise<DeleteCollectionResult> => {
    const present = await lockCollections(trx, householdId);
    const deleted = await trx.deleteFrom("recipe_collection").where("id", "=", input.collectionId).where("household_id", "=", householdId).returning("id").executeTakeFirst();
    if (!deleted) return { ok: true, deleted: false };
    await renumberCollections(
      trx,
      householdId,
      present.filter((id) => id !== input.collectionId),
    );
    return { ok: true, deleted: true };
  });
}

// --- §5 publishCollection (owner) ----------------------------------------

/**
 * Publish a collection to the acting owner's PDS (§5). **Owner-only** (§2.8).
 *
 * The acting owner becomes `published_by_did` and every later re-put travels
 * through their session, whichever household member made the edit (§2.5) — which
 * is why the confirmation dialog names them before this is ever called.
 *
 * The order is: role gate → kill switch → membership preflight → PDS create →
 * stamp the row. The PDS write is last because everything before it is free to
 * refuse, and a refusal must cost nothing.
 */
export const publishCollection = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ collectionId }).parse(data))
  .handler(async ({ data }): Promise<PublishCollectionResult> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId, "owner");
    return runPublishCollection(getDb(), did, householdId, data);
  });

/** The body of `publishCollection`. See `readCollections` for the contract. */
export const runPublishCollection = createServerOnlyFn(
  async (db: Kysely<DB>, did: string, householdId: string, input: { collectionId: string }): Promise<PublishCollectionResult> => {
    const { sql } = await import("kysely");
    const { isAtprotoPublishEnabled } = await import("#/lib/posthog-server");

    const collection = await readPublishRow(db, householdId, input.collectionId);
    if (!collection) throw new Error("That collection no longer exists.");
    // Already live: idempotent, the way publishing an already-public recipe is.
    if (collection.published_by_did && collection.uri) {
      return { ok: true, uri: collection.uri, publishedByDid: collection.published_by_did, publishedByHandle: await handleFor(db, collection.published_by_did) };
    }

    // Fail-closed kill switch (§2.3). Nothing has happened yet, so nothing is
    // left half-done by refusing here.
    if (!(await isAtprotoPublishEnabled(did))) return { ok: false, reason: "flag_disabled" };

    // §2.4: every member recipe must be published first. An empty collection is
    // legal and publishes with no `recipes` field at all (§8).
    const refs = await entryRefs(db, input.collectionId);
    const unpublished = unpublishedAmong(refs);
    if (unpublished.length > 0) return { ok: false, reason: "recipes_unpublished", recipeIds: unpublished };

    const { buildCollectionRecord, createCollectionRecord, deleteCollectionRecord } = await import("#/lib/atproto/collection-writes");
    // First publish: the record's createdAt is minted now and then frozen in
    // `record_created_at`, because every later re-put has to replay it.
    const now = new Date();
    const record = buildCollectionRecord({ name: collection.name, description: collection.description, recipes: entryRefsToStrongRefs(refs), createdAt: now, updatedAt: now });

    let created: { uri: string; cid: string; rkey: string; rev: string };
    try {
      created = await createCollectionRecord(did, record);
    } catch (err) {
      return pdsFailure(db, err, did);
    }

    // `published_by_did is null` is the compare-and-swap: two owners publishing
    // the same collection at the same moment must not both stamp the row.
    const stamped = await db
      .updateTable("recipe_collection")
      .set({
        published_by_did: did,
        rkey: created.rkey,
        uri: created.uri,
        cid: created.cid,
        rev: created.rev,
        published_at: sql`now()`,
        record_created_at: now,
        record_stale: false,
      })
      .where("id", "=", input.collectionId)
      .where("household_id", "=", householdId)
      .where("published_by_did", "is", null)
      .returning("id")
      .executeTakeFirst();

    if (!stamped) {
      // We lost the race (or the collection was deleted mid-flight). The record
      // we just created is unreferenced, so take it back off the PDS rather than
      // leave a live record nothing points at — the exact thing the delete
      // ordering above exists to prevent.
      await deleteCollectionRecord(did, created.rkey).catch((err: unknown) => console.warn(`[collections] could not roll back orphan record ${created.rkey}`, err));
      throw new Error("That collection was published by someone else just now.");
    }

    return { ok: true, uri: created.uri, publishedByDid: did, publishedByHandle: await handleFor(db, did) };
  },
);

// --- §5 unpublishCollection (owner) --------------------------------------

/**
 * Take the record off the publisher's PDS and keep the local collection (§2.7).
 * **Owner-only** (§2.8).
 *
 * The PDS delete goes first for the same reason `deleteCollection`'s does: the
 * rkey lives in the columns this clears. A failure leaves every publish column
 * untouched, so the retry still knows what to remove.
 */
export const unpublishCollection = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ collectionId }).parse(data))
  .handler(async ({ data }): Promise<UnpublishCollectionResult> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId, "owner");
    return runUnpublishCollection(getDb(), householdId, data);
  });

/** The body of `unpublishCollection`. See `readCollections` for the contract. */
export const runUnpublishCollection = createServerOnlyFn(async (db: Kysely<DB>, householdId: string, input: { collectionId: string }): Promise<UnpublishCollectionResult> => {
  const collection = await readPublishRow(db, householdId, input.collectionId);
  // Gone, or never published: the caller's goal already holds.
  if (!collection?.published_by_did || !collection.rkey) return { ok: true, unpublished: false };

  const { deleteCollectionRecord } = await import("#/lib/atproto/collection-writes");
  try {
    // As the PUBLISHER, not as the acting owner (§2.5) — the record is in their
    // repo and no other session can touch it.
    await deleteCollectionRecord(collection.published_by_did, collection.rkey);
  } catch (err) {
    return pdsFailure(db, err, collection.published_by_did);
  }

  // All seven publish columns together, or the all-or-none CHECK rejects it.
  // `record_stale` goes too: there is no published copy left to be behind.
  await db
    .updateTable("recipe_collection")
    .set({ published_by_did: null, rkey: null, uri: null, cid: null, rev: null, published_at: null, record_created_at: null, record_stale: false })
    .where("id", "=", input.collectionId)
    .where("household_id", "=", householdId)
    .execute();
  return { ok: true, unpublished: true };
});

// --- §5 retryCollectionSync ----------------------------------------------

/**
 * Re-run the re-put for one collection — the edit dialog's retry button behind
 * a stale badge (§5). Member-level: any member's edit re-puts the record, so any
 * member may retry the one that failed.
 *
 * Deliberately nothing more than {@link reputOrMarkStale} with the household
 * scope re-asserted: a retry that did anything else would be a second write path
 * to keep in step with the first.
 */
export const retryCollectionSync = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ collectionId }).parse(data))
  .handler(async ({ data }): Promise<{ stale: boolean }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return retrySync(getDb(), householdId, data);
  });

/** The body of `retryCollectionSync`. See `readCollections` for the contract. */
export async function retrySync(db: Kysely<DB>, householdId: string, input: { collectionId: string }): Promise<{ stale: boolean }> {
  const collection = await readCollectionRow(db, householdId, input.collectionId);
  // Another household's id (or a deleted one) has nothing to sync — and must
  // not become a PDS write on someone else's behalf.
  if (!collection) return { stale: false };
  return reputOrMarkStale(db, input.collectionId);
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
 * {@link renumberAfterUnfile} relies on, and the list of records
 * {@link reputEach} re-puts once the box removal commits.
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
