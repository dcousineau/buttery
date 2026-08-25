import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "#/db/types";
import { ulid } from "./household/ids";
import type { SaveRecipeResult } from "./recipes-write";

/**
 * DB-backed integration tests for collections (plan §9).
 *
 * These need a real Postgres with the migrations applied — the whole point is
 * the things a unit test cannot see: the CHECK constraints, the composite FK
 * that unfiles a recipe from every collection when it leaves the box, `FOR
 * UPDATE` locking, dense `position` rewrites across BOTH tables, and the
 * household join that IS the authorization.
 *
 * With no reachable database the whole suite SKIPS with a message rather than
 * failing, so `pnpm test` stays green on a machine that has never booted the
 * stack. See `services/web/vitest.config.ts` for the project split.
 *
 * The server functions take their household from the session, so the tests
 * drive the exported, session-free bodies (`readCollections`,
 * `insertCollection`, `fileRecipesIntoCollection`, …) that every handler
 * delegates to, and assert against the tables directly. Nothing here fakes a
 * session; the session → household resolution is the one line each handler
 * still owns. The role gate the handlers add on top is exercised through
 * `assertMember` itself, against this fixture's real membership rows.
 *
 * Every test rebuilds its own scratch fixture in `beforeEach` and the suite
 * deletes all of it in `afterAll`, so a run leaves the dev database exactly as
 * it found it and no test can depend on another.
 *
 * **The one thing faked here is the PDS** (milestone 5). `collection-writes.ts`
 * has its own unit tests for record building, and its three network functions
 * are stubbed below so this suite can assert what the *server* does with their
 * answers: which columns a successful publish stamps, that a failed delete
 * leaves every local row standing (§9), and that a failed re-put sets
 * `record_stale` instead of failing the write that triggered it. Everything
 * else — the database, the transactions, the locks, the authorization — is
 * real. Publish state is now created by the real `publishCollection` rather
 * than a hand-written UPDATE.
 */

// --- the faked PDS -------------------------------------------------------

/**
 * The three network calls in `#/lib/atproto/collection-writes`. Everything else
 * in that module — `buildCollectionRecord` above all — stays REAL, so the
 * records these spies receive are the records a PDS would have received.
 */
const pds = vi.hoisted(() => ({
  create: vi.fn<(did: string, record: unknown) => Promise<{ uri: string; cid: string; rkey: string; rev: string }>>(),
  put: vi.fn<(did: string, rkey: string, record: unknown, priorCid: string) => Promise<{ uri: string; cid: string; rev: string }>>(),
  remove: vi.fn<(did: string, rkey: string) => Promise<void>>(),
}));

vi.mock("#/lib/atproto/collection-writes", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createCollectionRecord: (did: string, record: unknown) => pds.create(did, record),
  putCollectionRecord: (did: string, rkey: string, record: unknown, priorCid: string) => pds.put(did, rkey, record, priorCid),
  deleteCollectionRecord: (did: string, rkey: string) => pds.remove(did, rkey),
}));

/** The rkey the faked PDS mints — a TID, because the lexicon's key type is `tid`. */
const MINTED_RKEY = "3lbtestcollectn";
const CREATED_CID = "bafycreated";
const PUT_CID = "bafyreput";

/** The happy path: every call succeeds. Re-applied before each test. */
function pdsSucceeds(): void {
  pds.create.mockImplementation((did) => Promise.resolve({ uri: `at://${did}/exchange.recipe.collection/${MINTED_RKEY}`, cid: CREATED_CID, rkey: MINTED_RKEY, rev: "rev-1" }));
  pds.put.mockImplementation((did, rkey) => Promise.resolve({ uri: `at://${did}/exchange.recipe.collection/${rkey}`, cid: PUT_CID, rev: "rev-2" }));
  pds.remove.mockResolvedValue(undefined);
}

/** The record body the last `createRecord` was handed. */
function lastCreatedRecord(): Record<string, unknown> {
  const call = pds.create.mock.calls.at(-1);
  if (!call) throw new Error("the PDS never saw a create");
  return call[1] as Record<string, unknown>;
}

/** The record body the last `putRecord` was handed. */
function lastPutRecord(): Record<string, unknown> {
  const call = pds.put.mock.calls.at(-1);
  if (!call) throw new Error("the PDS never saw a put");
  return call[2] as Record<string, unknown>;
}

// --- reachability probe --------------------------------------------------

let skipReason = "";

/**
 * `console` calls made while the module is still loading belong to no task, and
 * vitest drops them; a raw stderr write is the one thing that reliably reaches
 * the terminal from a file that then skips entirely.
 */
function announceSkip(reason: string): void {
  skipReason = reason;
  process.stderr.write(`\nSKIPPING collections DB tests — ${reason}.\nRun them against the local dev stack with \`pnpm test:db\`.\n\n`);
}

/**
 * Resolve a usable Kysely handle, or null. Probes for the collections table
 * specifically: a database that is up but un-migrated would otherwise fail every
 * test with an unhelpful "relation does not exist".
 */
async function connectOrSkip(): Promise<Kysely<DB> | null> {
  if (!process.env.DATABASE_URL) {
    announceSkip("DATABASE_URL is not set");
    return null;
  }
  const { getDb } = await import("#/lib/db");
  const db = getDb();
  try {
    // `pg` waits indefinitely for a TCP connect to a black-holed host, so the
    // probe is bounded rather than left to the suite timeout.
    await Promise.race([
      sql`select 1 from recipe_collection limit 0`.execute(db),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 5s")), 5_000).unref?.()),
    ]);
    return db;
  } catch (error) {
    announceSkip(`no reachable migrated database (${error instanceof Error ? error.message : String(error)})`);
    await db.destroy().catch(() => {});
    return null;
  }
}

const db = await connectOrSkip();

// --- fixture -------------------------------------------------------------

/** One namespace per run so a crashed run can never collide with the next. */
const RUN = ulid();

const HH_A = `hh-a-${RUN}`;
const HH_B = `hh-b-${RUN}`;
const HOUSEHOLDS = [HH_A, HH_B];

/** Owner of HH_A. */
const DID_A = `did:test:a-${RUN}`;
/** A plain member of HH_A — may file and reorder, may not delete (§2.8). */
const DID_M = `did:test:m-${RUN}`;
/** Owner of HH_B, and a member of nothing else. */
const DID_B = `did:test:b-${RUN}`;
const DIDS = [DID_A, DID_M, DID_B];

const R1 = `rec-1-${RUN}`;
const R2 = `rec-2-${RUN}`;
const R3 = `rec-3-${RUN}`;
/** Boxed, but never published — the `recipes_unpublished` preflight's subject. */
const R_DRAFT = `rec-draft-${RUN}`;
/** Public, but not in HH_A's box. */
const R_UNBOXED = `rec-unboxed-${RUN}`;
const RECIPES = [R1, R2, R3, R_DRAFT, R_UNBOXED];

// Loaded lazily so a skipped run never imports the server modules at all.
type Collections = typeof import("./collections");
type HouseholdRecipes = typeof import("./household-recipes");
let collections: Collections;
let box: HouseholdRecipes;
/** Whatever the environment said about the kill switch before this suite ran. */
let publishFlagBefore: string | undefined;

async function reset(): Promise<void> {
  if (!db) return;
  vi.clearAllMocks();
  pdsSucceeds();
  // Publishing is a fail-closed flag (§2.3); the env override is the only way to
  // turn it on outside production, and each test that cares sets it itself.
  process.env.ATPROTO_PUBLISH_ENABLED = "true";
  // Entries hang off both the collection and the box row; dropping the
  // collections takes them with it, and the box rows are rebuilt below.
  await db.deleteFrom("recipe_collection").where("household_id", "in", HOUSEHOLDS).execute();
  await db.deleteFrom("household_recipe").where("household_id", "in", HOUSEHOLDS).execute();
  // The "Publish recipe & add" tests publish this one for real; put it back.
  await db.updateTable("recipe").set({ visibility: "draft", uri: null, cid: null, did: null, rkey: null }).where("id", "=", R_DRAFT).execute();
  await db
    .insertInto("household_recipe")
    .values([
      { household_id: HH_A, recipe_id: R1, added_by_did: DID_A },
      { household_id: HH_A, recipe_id: R2, added_by_did: DID_A },
      { household_id: HH_A, recipe_id: R3, added_by_did: DID_M },
      { household_id: HH_A, recipe_id: R_DRAFT, added_by_did: DID_A },
      { household_id: HH_B, recipe_id: R1, added_by_did: DID_B },
    ])
    .execute();
}

// --- assertion helpers ---------------------------------------------------

/** Every collection in a household, in canonical read order. */
async function collectionRows(householdId: string) {
  return db!
    .selectFrom("recipe_collection")
    .select(["id", "name", "description", "position", "created_by_did", "published_by_did", "record_stale", "updated_at"])
    .where("household_id", "=", householdId)
    .orderBy("position")
    .orderBy("created_at")
    .execute();
}

/** One collection's entries, in canonical read order. */
async function entryRows(collectionId: string) {
  return db!
    .selectFrom("recipe_collection_entry")
    .select(["recipe_id", "position", "added_by_did", "household_id"])
    .where("collection_id", "=", collectionId)
    .orderBy("position")
    .orderBy("added_at")
    .execute();
}

/** §3: `position` is dense `0..n-1` within its scope, always. */
function expectDense(rows: Array<{ position: number }>): void {
  expect(rows.map((row) => row.position)).toEqual(rows.map((_, index) => index));
}

/** A Postgres error, as `pg` surfaces it. */
interface PgError extends Error {
  code?: string;
  constraint?: string;
}

async function expectRejects(run: () => Promise<unknown>): Promise<PgError> {
  try {
    await run();
  } catch (error) {
    return error as PgError;
  }
  throw new Error("expected the statement to be rejected, but it succeeded");
}

/** Create a collection in HH_A and return its id. */
async function makeCollection(name: string, did: string = DID_A): Promise<string> {
  const created = await collections.insertCollection(db!, did, HH_A, { name });
  return created.id;
}

/**
 * Publish a collection for real, against the faked PDS — the fixture every test
 * that needs publish state uses. `did` must be an owner (§2.8 is asserted
 * separately, through `assertMember`).
 */
async function markPublished(collectionId: string, did: string = DID_A): Promise<void> {
  const result = await collections.runPublishCollection(db!, did, did === DID_B ? HH_B : HH_A, { collectionId });
  if (!result.ok) throw new Error(`fixture publish failed: ${result.reason}`);
}

/** The publish columns of one collection, as the database holds them. */
async function publishState(collectionId: string) {
  return db!
    .selectFrom("recipe_collection")
    .select(["published_by_did", "rkey", "uri", "cid", "rev", "published_at", "record_created_at", "record_stale"])
    .where("id", "=", collectionId)
    .executeTakeFirstOrThrow();
}

// --- suite ---------------------------------------------------------------

// The reason rides along in the suite name too, so a verbose reporter's
// "skipped" line says why without anyone hunting for the stderr note.
describe.skipIf(!db)(db ? "collections DB integration (§9)" : `collections DB integration (§9) — SKIPPED: ${skipReason}`, () => {
  beforeAll(async () => {
    collections = await import("./collections");
    box = await import("./household-recipes");
    publishFlagBefore = process.env.ATPROTO_PUBLISH_ENABLED;

    await db!
      .insertInto("household")
      .values([
        { id: HH_A, name: "Scratch A", created_by_did: DID_A },
        { id: HH_B, name: "Scratch B", created_by_did: DID_B },
      ])
      .execute();
    await db!
      .insertInto("household_member")
      .values([
        { household_id: HH_A, did: DID_A, role: "owner", invited_by_did: null },
        { household_id: HH_A, did: DID_M, role: "member", invited_by_did: DID_A },
        { household_id: HH_B, did: DID_B, role: "owner", invited_by_did: null },
      ])
      .execute();
    await db!
      .insertInto("recipe")
      // A published recipe carries BOTH halves of its strongRef (`uri` + `cid`)
      // — half a ref cannot go in a collection record, so the publish preflight
      // counts a cid-less recipe as unpublished.
      .values([
        { id: R1, origin: "local", visibility: "public", name: "Shakshuka", uri: `at://${DID_A}/exchange.recipe.recipe/${R1}`, cid: `bafy-${R1}`, did: DID_A, rkey: R1 },
        { id: R2, origin: "local", visibility: "public", name: "Dal Tadka", uri: `at://${DID_A}/exchange.recipe.recipe/${R2}`, cid: `bafy-${R2}`, did: DID_A, rkey: R2 },
        { id: R3, origin: "local", visibility: "public", name: "Congee", uri: `at://${DID_A}/exchange.recipe.recipe/${R3}`, cid: `bafy-${R3}`, did: DID_A, rkey: R3 },
        { id: R_DRAFT, origin: "local", visibility: "draft", name: "Sunday Sauce" },
        {
          id: R_UNBOXED,
          origin: "local",
          visibility: "public",
          name: "Not In The Box",
          uri: `at://${DID_A}/exchange.recipe.recipe/${R_UNBOXED}`,
          cid: `bafy-${R_UNBOXED}`,
          did: DID_A,
        },
      ])
      .execute();
    // The publisher's "@handle" comes from the same two-table lookup the box's
    // adder attribution uses.
    await db!
      .insertInto("user")
      .values({ id: `user-${RUN}`, name: "A", email: `a-${RUN}@test.invalid`, emailVerified: false, did: DID_A, handle: `a-${RUN}.test` })
      .execute();
  });

  beforeEach(reset);

  afterAll(async () => {
    if (!db) return;
    if (publishFlagBefore === undefined) delete process.env.ATPROTO_PUBLISH_ENABLED;
    else process.env.ATPROTO_PUBLISH_ENABLED = publishFlagBefore;
    await db.deleteFrom("recipe_collection").where("household_id", "in", HOUSEHOLDS).execute();
    await db.deleteFrom("household_recipe").where("household_id", "in", HOUSEHOLDS).execute();
    await db.deleteFrom("household_member").where("household_id", "in", HOUSEHOLDS).execute();
    await db.deleteFrom("household").where("id", "in", HOUSEHOLDS).execute();
    await db.deleteFrom("recipe").where("id", "in", RECIPES).execute();
    await db.deleteFrom("user").where("did", "in", DIDS).execute();
    // Belt and suspenders: nothing keyed on this run's DIDs may survive.
    await db.deleteFrom("household_member").where("did", "in", DIDS).execute();
    await db.destroy();
  });

  // --- §3 CHECK constraints ----------------------------------------------

  describe("CHECK constraints reject malformed rows (§3)", () => {
    /** Bypasses every app-side validator on purpose — these are the DB's job. */
    function insertRaw(values: Record<string, unknown>) {
      return db!
        .insertInto("recipe_collection")
        .values({ id: ulid(), household_id: HH_A, name: "Raw", position: 0, created_by_did: DID_A, ...values })
        .execute();
    }

    it("accepts a well-formed row", async () => {
      await insertRaw({});
      expect(await collectionRows(HH_A)).toHaveLength(1);
    });

    it("rejects an empty name", async () => {
      const error = await expectRejects(() => insertRaw({ name: "" }));
      expect(error.code).toBe("23514");
      expect(error.constraint).toBe("recipe_collection_name_check");
    });

    it("rejects an over-long name", async () => {
      const error = await expectRejects(() => insertRaw({ name: "a".repeat(101) }));
      expect(error.constraint).toBe("recipe_collection_name_check");
    });

    it("rejects an over-long description", async () => {
      const error = await expectRejects(() => insertRaw({ description: "a".repeat(1001) }));
      expect(error.constraint).toBe("recipe_collection_description_check");
    });

    it("rejects a half-published row, and accepts a fully published one", async () => {
      const error = await expectRejects(() => insertRaw({ published_by_did: DID_A }));
      expect(error.constraint).toBe("recipe_collection_publish_shape_check");

      const id = await makeCollection("Published");
      await markPublished(id);
      expect((await collectionRows(HH_A))[0].published_by_did).toBe(DID_A);
    });

    it("allows duplicate names (§8 — quick-add must never collide)", async () => {
      await makeCollection("Weeknights");
      await makeCollection("Weeknights");
      expect((await collectionRows(HH_A)).map((row) => row.name)).toEqual(["Weeknights", "Weeknights"]);
    });

    it("refuses to file a recipe that is not in the household's box", async () => {
      const id = await makeCollection("Weeknights");
      const error = await expectRejects(() =>
        db!.insertInto("recipe_collection_entry").values({ collection_id: id, household_id: HH_A, recipe_id: R_UNBOXED, position: 0, added_by_did: DID_A }).execute(),
      );
      expect(error.code).toBe("23503");
      expect(error.constraint).toBe("recipe_collection_entry_box_fkey");
    });

    it("files a recipe into a collection at most once", async () => {
      const id = await makeCollection("Weeknights");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1] });
      const error = await expectRejects(() =>
        db!.insertInto("recipe_collection_entry").values({ collection_id: id, household_id: HH_A, recipe_id: R1, position: 9, added_by_did: DID_A }).execute(),
      );
      expect(error.code).toBe("23505");
    });
  });

  // --- §5 create / list --------------------------------------------------

  describe("createCollection appends at the bottom (§2.1)", () => {
    it("stamps dense positions in creation order", async () => {
      await makeCollection("First");
      await makeCollection("Second");
      await makeCollection("Third");
      const rows = await collectionRows(HH_A);
      expect(rows.map((row) => row.name)).toEqual(["First", "Second", "Third"]);
      expectDense(rows);
    });

    it("repairs a gap an earlier interrupted write left behind", async () => {
      const first = await makeCollection("First");
      await db!.updateTable("recipe_collection").set({ position: 7 }).where("id", "=", first).execute();
      await makeCollection("Second");
      expectDense(await collectionRows(HH_A));
    });

    it("returns a summary with empty membership and no publish state", async () => {
      const created = await collections.insertCollection(db!, DID_A, HH_A, { name: "Weeknights", description: "quick ones" });
      expect(created).toMatchObject({
        name: "Weeknights",
        description: "quick ones",
        position: 0,
        recipeIds: [],
        createdByDid: DID_A,
        publishedByDid: null,
        publishedByHandle: null,
        publishedAt: null,
        recordStale: false,
        uri: null,
      });
    });
  });

  describe("listCollections is the single read (§5)", () => {
    it("returns collections in position order, each with ordered membership", async () => {
      const weeknights = await makeCollection("Weeknights");
      const baking = await makeCollection("Baking");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: weeknights, recipeIds: [R2, R1] });
      await collections.orderCollections(db!, HH_A, { orderedIds: [baking, weeknights] });

      const list = await collections.readCollections(db!, DID_A, HH_A);
      expect(list.map((row) => row.name)).toEqual(["Baking", "Weeknights"]);
      expect(list.map((row) => row.position)).toEqual([0, 1]);
      expect(list[1].recipeIds).toEqual([R2, R1]);
      expect(list[0].recipeIds).toEqual([]);
    });

    it("resolves the publisher's @handle", async () => {
      const id = await makeCollection("Published");
      await markPublished(id);
      const [row] = await collections.readCollections(db!, DID_A, HH_A);
      expect(row.publishedByDid).toBe(DID_A);
      expect(row.publishedByHandle).toBe(`@a-${RUN}.test`);
      expect(row.publishedAt).toEqual(expect.any(String));
    });
  });

  // --- §5 update ---------------------------------------------------------

  describe("updateCollection", () => {
    it("renames, clears a description, and bumps updated_at", async () => {
      const id = await makeCollection("Weeknights");
      const before = (await collectionRows(HH_A))[0];
      await collections.patchCollection(db!, HH_A, { collectionId: id, name: "Weekdays", description: null });
      const after = (await collectionRows(HH_A))[0];
      expect(after.name).toBe("Weekdays");
      expect(after.description).toBeNull();
      expect(new Date(after.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(before.updated_at).getTime());
    });

    it("is a no-op when nothing was asked for", async () => {
      const id = await makeCollection("Weeknights");
      expect(await collections.patchCollection(db!, HH_A, { collectionId: id })).toEqual({ updated: false, stale: false });
    });
  });

  // --- §5 reordering, both tables ---------------------------------------

  describe("reorderCollections (§2.10 — local-only)", () => {
    it("applies the requested order densely", async () => {
      const a = await makeCollection("A");
      const b = await makeCollection("B");
      const c = await makeCollection("C");
      await collections.orderCollections(db!, HH_A, { orderedIds: [c, a, b] });
      const rows = await collectionRows(HH_A);
      expect(rows.map((row) => row.id)).toEqual([c, a, b]);
      expectDense(rows);
    });

    it("appends collections the client never mentioned, and ignores unknown ids", async () => {
      const a = await makeCollection("A");
      const b = await makeCollection("B");
      const c = await makeCollection("C");
      await collections.orderCollections(db!, HH_A, { orderedIds: [c, "not-a-collection", c] });
      const rows = await collectionRows(HH_A);
      expect(rows.map((row) => row.id)).toEqual([c, a, b]);
      expectDense(rows);
    });

    it("keeps the density invariant under interleaved reorders (§8)", async () => {
      const a = await makeCollection("A");
      const b = await makeCollection("B");
      const c = await makeCollection("C");
      // Two members dragging at the same moment. `FOR UPDATE` on the whole
      // household scope serializes them; whichever commits last wins, and the
      // list is dense either way.
      await Promise.all([collections.orderCollections(db!, HH_A, { orderedIds: [c, b, a] }), collections.orderCollections(db!, HH_A, { orderedIds: [b, a, c] })]);
      const rows = await collectionRows(HH_A);
      expectDense(rows);
      expect(rows.map((row) => row.id).sort()).toEqual([a, b, c].sort());
    });
  });

  describe("reorderCollectionRecipes (§2.10 — the published array order)", () => {
    it("applies the requested order densely and bumps the collection", async () => {
      const id = await makeCollection("Weeknights");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1, R2, R3] });
      await collections.orderCollectionRecipes(db!, HH_A, { collectionId: id, orderedRecipeIds: [R3, R1, R2] });
      const rows = await entryRows(id);
      expect(rows.map((row) => row.recipe_id)).toEqual([R3, R1, R2]);
      expectDense(rows);
    });

    it("is inert for a collection in another household", async () => {
      const id = await makeCollection("Weeknights");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1, R2] });
      expect(await collections.orderCollectionRecipes(db!, HH_B, { collectionId: id, orderedRecipeIds: [R2, R1] })).toEqual({ reordered: false, stale: false });
      expect((await entryRows(id)).map((row) => row.recipe_id)).toEqual([R1, R2]);
    });

    it("keeps the density invariant under interleaved reorders (§8)", async () => {
      const id = await makeCollection("Weeknights");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1, R2, R3] });
      await Promise.all([
        collections.orderCollectionRecipes(db!, HH_A, { collectionId: id, orderedRecipeIds: [R3, R2, R1] }),
        collections.orderCollectionRecipes(db!, HH_A, { collectionId: id, orderedRecipeIds: [R2, R1, R3] }),
      ]);
      const rows = await entryRows(id);
      expectDense(rows);
      expect(rows.map((row) => row.recipe_id).sort()).toEqual([R1, R2, R3].sort());
    });
  });

  // --- §5 filing / unfiling ---------------------------------------------

  describe("addRecipesToCollection", () => {
    it("appends at the bottom in the order given, densely", async () => {
      const id = await makeCollection("Weeknights");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R2] });
      const result = await collections.fileRecipesIntoCollection(db!, DID_M, HH_A, { collectionId: id, recipeIds: [R3, R1] });
      expect(result).toEqual({ ok: true, added: [R3, R1], stale: false });
      const rows = await entryRows(id);
      expect(rows.map((row) => row.recipe_id)).toEqual([R2, R3, R1]);
      expect(rows.map((row) => row.added_by_did)).toEqual([DID_A, DID_M, DID_M]);
      expectDense(rows);
    });

    it("ignores an already-filed recipe rather than moving it (§8)", async () => {
      const id = await makeCollection("Weeknights");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1, R2] });
      const result = await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1, R3] });
      expect(result).toEqual({ ok: true, added: [R3], stale: false });
      expect((await entryRows(id)).map((row) => row.recipe_id)).toEqual([R1, R2, R3]);
    });

    it("rejects the whole call when any recipe is not in the box", async () => {
      const id = await makeCollection("Weeknights");
      await expect(collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1, R_UNBOXED] })).rejects.toThrow(/not in this household's box/);
      expect(await entryRows(id)).toEqual([]);
    });

    it("refuses an unpublished recipe when the collection is published (§2.4)", async () => {
      const id = await makeCollection("Published");
      await markPublished(id);
      const result = await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1, R_DRAFT] });
      expect(result).toEqual({ ok: false, reason: "recipes_unpublished", recipeIds: [R_DRAFT] });
      // Nothing was filed — the preflight fails the whole call, so the picker
      // can offer "Publish recipe & add" against exactly those ids.
      expect(await entryRows(id)).toEqual([]);
    });

    it("files an unpublished recipe freely into an unpublished collection", async () => {
      const id = await makeCollection("Private");
      const result = await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R_DRAFT] });
      expect(result).toEqual({ ok: true, added: [R_DRAFT], stale: false });
    });

    it("refuses a collection in another household", async () => {
      const id = await makeCollection("Weeknights");
      await expect(collections.fileRecipesIntoCollection(db!, DID_B, HH_B, { collectionId: id, recipeIds: [R1] })).rejects.toThrow(/no longer exists/);
    });
  });

  describe("removeRecipeFromCollection", () => {
    it("closes the hole the entry left", async () => {
      const id = await makeCollection("Weeknights");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1, R2, R3] });
      expect(await collections.unfileRecipeFromCollection(db!, HH_A, { collectionId: id, recipeId: R2 })).toEqual({ removed: true, stale: false });
      const rows = await entryRows(id);
      expect(rows.map((row) => row.recipe_id)).toEqual([R1, R3]);
      expectDense(rows);
    });

    it("is idempotent", async () => {
      const id = await makeCollection("Weeknights");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1] });
      await collections.unfileRecipeFromCollection(db!, HH_A, { collectionId: id, recipeId: R1 });
      expect(await collections.unfileRecipeFromCollection(db!, HH_A, { collectionId: id, recipeId: R1 })).toEqual({ removed: false, stale: false });
    });

    it("is inert for a collection in another household", async () => {
      const id = await makeCollection("Weeknights");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1] });
      expect(await collections.unfileRecipeFromCollection(db!, HH_B, { collectionId: id, recipeId: R1 })).toEqual({ removed: false, stale: false });
      expect(await entryRows(id)).toHaveLength(1);
    });
  });

  // --- §5 delete ---------------------------------------------------------

  describe("deleteCollection", () => {
    it("hard-deletes the collection, cascades its entries and renumbers the rest", async () => {
      const a = await makeCollection("A");
      const b = await makeCollection("B");
      const c = await makeCollection("C");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: b, recipeIds: [R1, R2] });

      expect(await collections.removeCollection(db!, HH_A, { collectionId: b })).toEqual({ ok: true, deleted: true });
      const rows = await collectionRows(HH_A);
      expect(rows.map((row) => row.id)).toEqual([a, c]);
      expectDense(rows);
      expect(await entryRows(b)).toEqual([]);
    });

    it("is idempotent, and inert for another household's collection", async () => {
      const id = await makeCollection("A");
      expect(await collections.removeCollection(db!, HH_B, { collectionId: id })).toEqual({ ok: true, deleted: false });
      expect(await collections.removeCollection(db!, HH_A, { collectionId: id })).toEqual({ ok: true, deleted: true });
      expect(await collections.removeCollection(db!, HH_A, { collectionId: id })).toEqual({ ok: true, deleted: false });
    });
  });

  // --- §2.11 the box-removal cascade ------------------------------------

  describe("removing a recipe from the box unfiles it everywhere (§2.11)", () => {
    it("cascades the entries away and renumbers every affected collection", async () => {
      const a = await makeCollection("A");
      const b = await makeCollection("B");
      const untouched = await makeCollection("Untouched");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: a, recipeIds: [R1, R2, R3] });
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: b, recipeIds: [R2, R1] });
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: untouched, recipeIds: [R3] });

      const result = await box.unboxRecipe(db!, HH_A, R2);
      expect(result.unfiledFrom).toEqual([a, b].sort());

      const rowsA = await entryRows(a);
      expect(rowsA.map((row) => row.recipe_id)).toEqual([R1, R3]);
      expectDense(rowsA);

      const rowsB = await entryRows(b);
      expect(rowsB.map((row) => row.recipe_id)).toEqual([R1]);
      expectDense(rowsB);

      expect((await entryRows(untouched)).map((row) => row.recipe_id)).toEqual([R3]);
      // And the box row itself is gone.
      expect(await db!.selectFrom("household_recipe").select("recipe_id").where("household_id", "=", HH_A).where("recipe_id", "=", R2).executeTakeFirst()).toBeUndefined();
    });

    it("reports no affected collections when the recipe was filed nowhere", async () => {
      await makeCollection("A");
      expect(await box.unboxRecipe(db!, HH_A, R2)).toEqual({ unfiledFrom: [], staleCollectionIds: [] });
    });

    it("leaves another household's filing of the same recipe alone", async () => {
      const mine = await makeCollection("Mine");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: mine, recipeIds: [R1] });
      const theirs = await collections.insertCollection(db!, DID_B, HH_B, { name: "Theirs" });
      await collections.fileRecipesIntoCollection(db!, DID_B, HH_B, { collectionId: theirs.id, recipeIds: [R1] });

      await box.unboxRecipe(db!, HH_A, R1);
      expect(await entryRows(mine)).toEqual([]);
      expect((await entryRows(theirs.id)).map((row) => row.recipe_id)).toEqual([R1]);
    });
  });

  // --- §5 publish --------------------------------------------------------

  describe("publishCollection (§5, owner-only)", () => {
    it("stamps every publish column from the PDS's answer, rkey included", async () => {
      const id = await makeCollection("Weeknights");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1] });

      const result = await collections.runPublishCollection(db!, DID_A, HH_A, { collectionId: id });
      expect(result).toEqual({ ok: true, uri: `at://${DID_A}/exchange.recipe.collection/${MINTED_RKEY}`, publishedByDid: DID_A, publishedByHandle: `@a-${RUN}.test` });

      const state = await publishState(id);
      // The rkey is the PDS's, parsed off the returned uri — never ours (§1).
      expect(state).toMatchObject({ published_by_did: DID_A, rkey: MINTED_RKEY, cid: CREATED_CID, rev: "rev-1", record_stale: false });
      expect(state.published_at).toBeInstanceOf(Date);
      expect(state.record_created_at).toBeInstanceOf(Date);
      expect(pds.create).toHaveBeenCalledTimes(1);
    });

    it("writes the entries as strongRefs, in position order", async () => {
      const id = await makeCollection("Weeknights");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R3, R1] });
      await collections.runPublishCollection(db!, DID_A, HH_A, { collectionId: id });

      const record = lastCreatedRecord();
      expect(record.name).toBe("Weeknights");
      expect(record.recipes).toEqual([
        { uri: `at://${DID_A}/exchange.recipe.recipe/${R3}`, cid: `bafy-${R3}` },
        { uri: `at://${DID_A}/exchange.recipe.recipe/${R1}`, cid: `bafy-${R1}` },
      ]);
    });

    it("publishes an empty collection with no `recipes` field at all (§8)", async () => {
      const id = await makeCollection("Empty");
      expect(await collections.runPublishCollection(db!, DID_A, HH_A, { collectionId: id })).toMatchObject({ ok: true });
      expect(lastCreatedRecord()).not.toHaveProperty("recipes");
    });

    it("refuses while any member recipe is unpublished (§2.4), and writes nothing", async () => {
      const id = await makeCollection("Weeknights");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1, R_DRAFT] });

      expect(await collections.runPublishCollection(db!, DID_A, HH_A, { collectionId: id })).toEqual({ ok: false, reason: "recipes_unpublished", recipeIds: [R_DRAFT] });
      expect(pds.create).not.toHaveBeenCalled();
      expect((await publishState(id)).published_by_did).toBeNull();
    });

    it("counts a recipe with no cid as unpublished — half a strongRef is not a ref", async () => {
      const id = await makeCollection("Weeknights");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1] });
      await db!.updateTable("recipe").set({ cid: null }).where("id", "=", R1).execute();

      expect(await collections.runPublishCollection(db!, DID_A, HH_A, { collectionId: id })).toEqual({ ok: false, reason: "recipes_unpublished", recipeIds: [R1] });
      await db!
        .updateTable("recipe")
        .set({ cid: `bafy-${R1}` })
        .where("id", "=", R1)
        .execute();
    });

    it("fails closed when the kill switch is off (§2.3)", async () => {
      process.env.ATPROTO_PUBLISH_ENABLED = "false";
      const id = await makeCollection("Weeknights");
      expect(await collections.runPublishCollection(db!, DID_A, HH_A, { collectionId: id })).toEqual({ ok: false, reason: "flag_disabled" });
      expect(pds.create).not.toHaveBeenCalled();
    });

    it("is idempotent: publishing an already-published collection creates no second record", async () => {
      const id = await makeCollection("Weeknights");
      await markPublished(id);
      const again = await collections.runPublishCollection(db!, DID_A, HH_A, { collectionId: id });
      expect(again).toMatchObject({ ok: true, publishedByDid: DID_A });
      expect(pds.create).toHaveBeenCalledTimes(1);
    });

    it("reports an under-scoped grant as scope_error, leaving the collection unpublished", async () => {
      const { AtprotoScopeError } = await import("#/lib/atproto/recipe-writes");
      pds.create.mockRejectedValue(new AtprotoScopeError("repo:exchange.recipe.collection"));

      const id = await makeCollection("Weeknights");
      expect(await collections.runPublishCollection(db!, DID_A, HH_A, { collectionId: id })).toEqual({
        ok: false,
        reason: "scope_error",
        missingScope: "repo:exchange.recipe.collection",
      });
      expect((await publishState(id)).published_by_did).toBeNull();
    });

    it("reports any other PDS failure as publisher_unavailable, naming the handle (§8)", async () => {
      pds.create.mockRejectedValue(new Error("session could not be restored"));
      const id = await makeCollection("Weeknights");
      expect(await collections.runPublishCollection(db!, DID_A, HH_A, { collectionId: id })).toEqual({ ok: false, reason: "publisher_unavailable", handle: `@a-${RUN}.test` });
      expect((await publishState(id)).published_by_did).toBeNull();
    });

    it("is inert for a collection in another household", async () => {
      const id = await makeCollection("Weeknights");
      await expect(collections.runPublishCollection(db!, DID_B, HH_B, { collectionId: id })).rejects.toThrow(/no longer exists/);
      expect(pds.create).not.toHaveBeenCalled();
    });
  });

  // --- §5 the re-put plumbing --------------------------------------------

  describe("reputOrMarkStale keeps the record in step (§5)", () => {
    it("does nothing at all for an unpublished collection", async () => {
      const id = await makeCollection("Private");
      expect(await collections.reputOrMarkStale(db!, id)).toEqual({ stale: false });
      expect(pds.put).not.toHaveBeenCalled();
    });

    it("re-puts after a rename, replaying the frozen createdAt and CAS-ing on the last cid", async () => {
      const id = await makeCollection("Weeknights");
      await markPublished(id);
      const published = await publishState(id);

      expect(await collections.patchCollection(db!, HH_A, { collectionId: id, name: "Weekdays", description: "quick ones" })).toEqual({ updated: true, stale: false });

      expect(pds.put).toHaveBeenCalledTimes(1);
      // As the publisher, at the PDS-minted rkey, guarded by the cid we hold.
      expect(pds.put.mock.calls[0][0]).toBe(DID_A);
      expect(pds.put.mock.calls[0][1]).toBe(MINTED_RKEY);
      expect(pds.put.mock.calls[0][3]).toBe(CREATED_CID);

      const record = lastPutRecord();
      expect(record.name).toBe("Weekdays");
      expect(record.text).toBe("quick ones");
      // A record's createdAt must never drift across re-puts.
      expect(record.createdAt).toBe(new Date(published.record_created_at!).toISOString());

      // …and the new cid/rev are what the next CAS will use.
      expect(await publishState(id)).toMatchObject({ cid: PUT_CID, rev: "rev-2", record_stale: false });
    });

    it("re-puts on every membership and order change", async () => {
      const id = await makeCollection("Weeknights");
      await markPublished(id);

      expect(await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1, R2] })).toEqual({ ok: true, added: [R1, R2], stale: false });
      expect(lastPutRecord().recipes).toHaveLength(2);

      expect(await collections.orderCollectionRecipes(db!, HH_A, { collectionId: id, orderedRecipeIds: [R2, R1] })).toEqual({ reordered: true, stale: false });
      expect(lastPutRecord().recipes).toEqual([
        { uri: `at://${DID_A}/exchange.recipe.recipe/${R2}`, cid: `bafy-${R2}` },
        { uri: `at://${DID_A}/exchange.recipe.recipe/${R1}`, cid: `bafy-${R1}` },
      ]);

      expect(await collections.unfileRecipeFromCollection(db!, HH_A, { collectionId: id, recipeId: R2 })).toEqual({ removed: true, stale: false });
      expect(lastPutRecord().recipes).toEqual([{ uri: `at://${DID_A}/exchange.recipe.recipe/${R1}`, cid: `bafy-${R1}` }]);

      expect(pds.put).toHaveBeenCalledTimes(3);
    });

    it("never re-puts the household list order (§2.10)", async () => {
      const a = await makeCollection("A");
      const b = await makeCollection("B");
      await markPublished(a);
      pds.put.mockClear();
      await collections.orderCollections(db!, HH_A, { orderedIds: [b, a] });
      expect(pds.put).not.toHaveBeenCalled();
    });

    it("marks the record stale when the PDS refuses — and the local write still succeeds", async () => {
      const id = await makeCollection("Weeknights");
      await markPublished(id);
      pds.put.mockRejectedValue(new Error("publisher's PDS is unreachable"));

      // The rename is saved. `stale` is an annotation, not a failure (§8).
      expect(await collections.patchCollection(db!, HH_A, { collectionId: id, name: "Weekdays" })).toEqual({ updated: true, stale: true });
      expect((await collectionRows(HH_A))[0].name).toBe("Weekdays");
      const state = await publishState(id);
      expect(state.record_stale).toBe(true);
      // The old cid stays: it is still what is actually on the PDS.
      expect(state.cid).toBe(CREATED_CID);
    });

    it("marks stale on an under-scoped grant too — the caller's edit is never rolled back", async () => {
      const { AtprotoScopeError } = await import("#/lib/atproto/recipe-writes");
      const id = await makeCollection("Weeknights");
      await markPublished(id);
      pds.put.mockRejectedValue(new AtprotoScopeError("repo:exchange.recipe.collection"));

      expect(await collections.fileRecipesIntoCollection(db!, DID_M, HH_A, { collectionId: id, recipeIds: [R1] })).toEqual({ ok: true, added: [R1], stale: true });
      expect((await entryRows(id)).map((row) => row.recipe_id)).toEqual([R1]);
      expect((await publishState(id)).record_stale).toBe(true);
    });

    it("clears the stale flag on the next successful write", async () => {
      const id = await makeCollection("Weeknights");
      await markPublished(id);
      pds.put.mockRejectedValueOnce(new Error("transient"));

      expect(await collections.patchCollection(db!, HH_A, { collectionId: id, name: "Weekdays" })).toEqual({ updated: true, stale: true });
      expect(await collections.patchCollection(db!, HH_A, { collectionId: id, name: "Weeknights" })).toEqual({ updated: true, stale: false });
      expect((await publishState(id)).record_stale).toBe(false);
    });

    it("re-puts every published collection a recipe leaves behind when it leaves the box (§2.11)", async () => {
      const published = await makeCollection("Published");
      const private_ = await makeCollection("Private");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: published, recipeIds: [R1, R2] });
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: private_, recipeIds: [R2] });
      await markPublished(published);
      pds.put.mockClear();

      expect(await box.unboxRecipe(db!, HH_A, R2)).toEqual({ unfiledFrom: [published, private_].sort(), staleCollectionIds: [] });
      // Only the published one is a record; the private one is local state.
      expect(pds.put).toHaveBeenCalledTimes(1);
      expect(lastPutRecord().recipes).toEqual([{ uri: `at://${DID_A}/exchange.recipe.recipe/${R1}`, cid: `bafy-${R1}` }]);
    });

    it("reports which collections went stale when the box removal's re-put fails", async () => {
      const id = await makeCollection("Published");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1, R2] });
      await markPublished(id);
      pds.put.mockRejectedValue(new Error("publisher's PDS is unreachable"));

      expect(await box.unboxRecipe(db!, HH_A, R2)).toEqual({ unfiledFrom: [id], staleCollectionIds: [id] });
      // The unfiling itself still happened, densely.
      expect((await entryRows(id)).map((row) => row.recipe_id)).toEqual([R1]);
      expect((await publishState(id)).record_stale).toBe(true);
    });
  });

  describe("retryCollectionSync", () => {
    it("re-runs the re-put and clears the stale flag", async () => {
      const id = await makeCollection("Weeknights");
      await markPublished(id);
      pds.put.mockRejectedValueOnce(new Error("transient"));
      expect(await collections.patchCollection(db!, HH_A, { collectionId: id, name: "Weekdays" })).toEqual({ updated: true, stale: true });

      expect(await collections.retrySync(db!, HH_A, { collectionId: id })).toEqual({ stale: false });
      expect((await publishState(id)).record_stale).toBe(false);
      expect(lastPutRecord().name).toBe("Weekdays");
    });

    it("is inert for another household's collection", async () => {
      const id = await makeCollection("Weeknights");
      await markPublished(id);
      pds.put.mockClear();
      expect(await collections.retrySync(db!, HH_B, { collectionId: id })).toEqual({ stale: false });
      expect(pds.put).not.toHaveBeenCalled();
    });
  });

  // --- §2.7 unpublish -----------------------------------------------------

  describe("unpublishCollection (§2.7, owner-only)", () => {
    it("deletes the record as the publisher and clears every publish column, keeping the rows", async () => {
      const id = await makeCollection("Weeknights");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1] });
      await markPublished(id);

      expect(await collections.runUnpublishCollection(db!, HH_A, { collectionId: id })).toEqual({ ok: true, unpublished: true });
      expect(pds.remove).toHaveBeenCalledWith(DID_A, MINTED_RKEY);

      // All seven columns, or the all-or-none CHECK would have refused.
      expect(await publishState(id)).toEqual({
        published_by_did: null,
        rkey: null,
        uri: null,
        cid: null,
        rev: null,
        published_at: null,
        record_created_at: null,
        record_stale: false,
      });
      // The collection and its entries survive — that is the whole point (§2.7).
      expect(await collectionRows(HH_A)).toHaveLength(1);
      expect((await entryRows(id)).map((row) => row.recipe_id)).toEqual([R1]);
    });

    it("keeps the publish columns when the PDS refuses, so the retry still knows the rkey", async () => {
      const id = await makeCollection("Weeknights");
      await markPublished(id);
      pds.remove.mockRejectedValue(new Error("publisher's PDS is unreachable"));

      expect(await collections.runUnpublishCollection(db!, HH_A, { collectionId: id })).toEqual({ ok: false, reason: "publisher_unavailable", handle: `@a-${RUN}.test` });
      expect(await publishState(id)).toMatchObject({ published_by_did: DID_A, rkey: MINTED_RKEY });
    });

    it("is a no-op for a collection that was never published", async () => {
      const id = await makeCollection("Private");
      expect(await collections.runUnpublishCollection(db!, HH_A, { collectionId: id })).toEqual({ ok: true, unpublished: false });
      expect(pds.remove).not.toHaveBeenCalled();
    });

    it("is inert for another household's collection", async () => {
      const id = await makeCollection("Weeknights");
      await markPublished(id);
      expect(await collections.runUnpublishCollection(db!, HH_B, { collectionId: id })).toEqual({ ok: true, unpublished: false });
      expect(pds.remove).not.toHaveBeenCalled();
      expect((await publishState(id)).published_by_did).toBe(DID_A);
    });
  });

  // --- §9 delete with a failing PDS ---------------------------------------

  describe("deleteCollection deletes from the PDS first (§5, §9)", () => {
    it("keeps every local row when the PDS delete fails", async () => {
      const keep = await makeCollection("Keep");
      const doomed = await makeCollection("Doomed");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: doomed, recipeIds: [R1, R2] });
      await markPublished(doomed);
      pds.remove.mockRejectedValue(new Error("publisher's PDS is unreachable"));

      expect(await collections.removeCollection(db!, HH_A, { collectionId: doomed })).toEqual({ ok: false, reason: "publisher_unavailable", handle: `@a-${RUN}.test` });

      // Nothing was deleted anywhere: the row, its entries and its publish
      // state are all exactly as they were. Deleting locally first would have
      // orphaned a live record with nothing left pointing at it.
      const rows = await collectionRows(HH_A);
      expect(rows.map((row) => row.id)).toEqual([keep, doomed]);
      expectDense(rows);
      expect((await entryRows(doomed)).map((row) => row.recipe_id)).toEqual([R1, R2]);
      expect(await publishState(doomed)).toMatchObject({ published_by_did: DID_A, rkey: MINTED_RKEY });
    });

    it("reports an under-scoped grant as scope_error, and still deletes nothing", async () => {
      const { AtprotoScopeError } = await import("#/lib/atproto/recipe-writes");
      const id = await makeCollection("Doomed");
      await markPublished(id);
      pds.remove.mockRejectedValue(new AtprotoScopeError("repo:exchange.recipe.collection"));

      expect(await collections.removeCollection(db!, HH_A, { collectionId: id })).toEqual({ ok: false, reason: "scope_error", missingScope: "repo:exchange.recipe.collection" });
      expect(await collectionRows(HH_A)).toHaveLength(1);
    });

    it("removes the record first, then the local rows, then renumbers", async () => {
      const a = await makeCollection("A");
      const doomed = await makeCollection("Doomed");
      const c = await makeCollection("C");
      await markPublished(doomed);

      expect(await collections.removeCollection(db!, HH_A, { collectionId: doomed })).toEqual({ ok: true, deleted: true });
      expect(pds.remove).toHaveBeenCalledWith(DID_A, MINTED_RKEY);
      const rows = await collectionRows(HH_A);
      expect(rows.map((row) => row.id)).toEqual([a, c]);
      expectDense(rows);
    });

    it("touches no PDS at all for an unpublished collection", async () => {
      const id = await makeCollection("Private");
      expect(await collections.removeCollection(db!, HH_A, { collectionId: id })).toEqual({ ok: true, deleted: true });
      expect(pds.remove).not.toHaveBeenCalled();
    });
  });

  // --- §5 "Publish recipe & add" ------------------------------------------

  describe("addRecipesToCollection's publish-and-add combo (§5)", () => {
    /** Stands in for the recipe publish path — see `RecipePublisher`. */
    function publisher(result?: SaveRecipeResult) {
      return vi.fn(async (id: string): Promise<SaveRecipeResult> => {
        if (result) return result;
        await db!
          .updateTable("recipe")
          .set({ visibility: "public", uri: `at://${DID_A}/exchange.recipe.recipe/${id}`, cid: `bafy-${id}`, did: DID_A, rkey: id })
          .where("id", "=", id)
          .execute();
        return { status: "ok", recipeId: id, published: true };
      });
    }

    it("publishes the consented recipe first, then files everything in order", async () => {
      const id = await makeCollection("Published");
      await markPublished(id);
      const publish = publisher();

      const result = await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1, R_DRAFT], publishRecipeIds: [R_DRAFT] }, publish);

      expect(result).toEqual({ ok: true, added: [R1, R_DRAFT], stale: false });
      // Only the unpublished one was published — R1 already was.
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith(R_DRAFT);
      expect((await entryRows(id)).map((row) => row.recipe_id)).toEqual([R1, R_DRAFT]);
      // …and the freshly published recipe is a real ref in the record.
      expect(lastPutRecord().recipes).toEqual([
        { uri: `at://${DID_A}/exchange.recipe.recipe/${R1}`, cid: `bafy-${R1}` },
        { uri: `at://${DID_A}/exchange.recipe.recipe/${R_DRAFT}`, cid: `bafy-${R_DRAFT}` },
      ]);
    });

    it("still blocks an unpublished recipe the user did not consent to", async () => {
      const id = await makeCollection("Published");
      await markPublished(id);
      const publish = publisher();

      const result = await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1, R_DRAFT], publishRecipeIds: [] }, publish);
      expect(result).toEqual({ ok: false, reason: "recipes_unpublished", recipeIds: [R_DRAFT] });
      expect(publish).not.toHaveBeenCalled();
      expect(await entryRows(id)).toEqual([]);
    });

    it("maps the recipe kill switch onto flag_disabled and files nothing", async () => {
      const id = await makeCollection("Published");
      await markPublished(id);
      const publish = publisher({ status: "publish_disabled", recipeId: R_DRAFT });

      const result = await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R_DRAFT], publishRecipeIds: [R_DRAFT] }, publish);
      expect(result).toEqual({ ok: false, reason: "flag_disabled" });
      expect(await entryRows(id)).toEqual([]);
    });

    it("maps an under-scoped grant onto scope_error", async () => {
      const id = await makeCollection("Published");
      await markPublished(id);
      const publish = publisher({ status: "reauth_required", recipeId: R_DRAFT, missingScope: "repo:exchange.recipe.recipe" });

      const result = await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R_DRAFT], publishRecipeIds: [R_DRAFT] }, publish);
      expect(result).toEqual({ ok: false, reason: "scope_error", missingScope: "repo:exchange.recipe.recipe" });
    });

    it("reports a recipe that would not publish as still unpublished", async () => {
      const id = await makeCollection("Published");
      await markPublished(id);
      const publish = publisher({ status: "duplicate", existingRecipeId: R1 });

      const result = await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R_DRAFT], publishRecipeIds: [R_DRAFT] }, publish);
      expect(result).toEqual({ ok: false, reason: "recipes_unpublished", recipeIds: [R_DRAFT] });
      expect(await entryRows(id)).toEqual([]);
    });

    it("ignores publishRecipeIds entirely for an unpublished collection", async () => {
      const id = await makeCollection("Private");
      const publish = publisher();
      const result = await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R_DRAFT], publishRecipeIds: [R_DRAFT] }, publish);
      expect(result).toEqual({ ok: true, added: [R_DRAFT], stale: false });
      // A private collection has no reason to publish anything (§2.4).
      expect(publish).not.toHaveBeenCalled();
    });
  });

  // --- §2.8 authorization ------------------------------------------------

  describe("authorization (§2.8)", () => {
    it("shows a non-member nothing, however many collections exist", async () => {
      await makeCollection("Weeknights");
      // The `householdScopedQuery` membership join IS the gate: DID_B is a live
      // member of HH_B, of nothing else.
      expect(await collections.readCollections(db!, DID_B, HH_A)).toEqual([]);
      expect(await collections.readCollections(db!, DID_A, HH_A)).toHaveLength(1);
    });

    it("keeps every write inert against a collection from another household", async () => {
      const id = await makeCollection("Weeknights");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1] });

      expect(await collections.patchCollection(db!, HH_B, { collectionId: id, name: "Stolen" })).toEqual({ updated: false, stale: false });
      expect(await collections.orderCollectionRecipes(db!, HH_B, { collectionId: id, orderedRecipeIds: [R1] })).toEqual({ reordered: false, stale: false });
      expect(await collections.unfileRecipeFromCollection(db!, HH_B, { collectionId: id, recipeId: R1 })).toEqual({ removed: false, stale: false });
      expect(await collections.removeCollection(db!, HH_B, { collectionId: id })).toEqual({ ok: true, deleted: false });
      await expect(collections.fileRecipesIntoCollection(db!, DID_B, HH_B, { collectionId: id, recipeIds: [R1] })).rejects.toThrow(/no longer exists/);

      const rows = await collectionRows(HH_A);
      expect(rows[0].name).toBe("Weeknights");
      expect(await entryRows(id)).toHaveLength(1);
    });

    /**
     * The role gate lives in the four handlers' one shared line — `assertMember(
     * did, householdId, "owner")` — and the handlers resolve their own session,
     * which a db test has none of. So the gate is asserted where it decides:
     * against this fixture's real membership rows. If one of the four ever drops
     * the argument, this test still passes and `import-authz.test.ts`'s entry
     * point list is the net; the pairing is deliberate and predates milestone 5.
     */
    it("lets a plain member write, but not publish, unpublish or delete", async () => {
      const { assertMember } = await import("./authz");
      const { InsufficientRoleError, NotAMemberError } = await import("./household/errors");

      // Members create, file, reorder — and retry a failed sync.
      await expect(assertMember(DID_M, HH_A)).resolves.toMatchObject({ role: "member" });
      // `publishCollection`, `unpublishCollection` and `deleteCollection` (§2.8).
      await expect(assertMember(DID_M, HH_A, "owner")).rejects.toBeInstanceOf(InsufficientRoleError);
      await expect(assertMember(DID_A, HH_A, "owner")).resolves.toMatchObject({ role: "owner" });
      // And a non-member is nothing at all.
      await expect(assertMember(DID_B, HH_A)).rejects.toBeInstanceOf(NotAMemberError);
    });

    it("keeps the owner writes inert against another household's collection", async () => {
      const id = await makeCollection("Weeknights");
      await markPublished(id);
      pds.create.mockClear();
      pds.remove.mockClear();

      await expect(collections.runPublishCollection(db!, DID_B, HH_B, { collectionId: id })).rejects.toThrow(/no longer exists/);
      expect(await collections.runUnpublishCollection(db!, HH_B, { collectionId: id })).toEqual({ ok: true, unpublished: false });
      expect(await collections.removeCollection(db!, HH_B, { collectionId: id })).toEqual({ ok: true, deleted: false });
      expect(await collections.retrySync(db!, HH_B, { collectionId: id })).toEqual({ stale: false });

      // Not one PDS call was made on another household's behalf.
      expect(pds.create).not.toHaveBeenCalled();
      expect(pds.put).not.toHaveBeenCalled();
      expect(pds.remove).not.toHaveBeenCalled();
      expect((await publishState(id)).published_by_did).toBe(DID_A);
    });
  });
});
