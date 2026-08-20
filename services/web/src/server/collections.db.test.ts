import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "#/db/types";
import { ulid } from "./household/ids";

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
 * NOT here, because milestone 1 has no publish path: the "delete with a failing
 * PDS keeps the local rows" case (§9). It arrives with `deleteCollectionRecord`
 * in milestone 5, which is also when a row can first carry publish state from
 * anything other than a hand-written `UPDATE` — as the preflight test below
 * does.
 */

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

async function reset(): Promise<void> {
  if (!db) return;
  // Entries hang off both the collection and the box row; dropping the
  // collections takes them with it, and the box rows are rebuilt below.
  await db.deleteFrom("recipe_collection").where("household_id", "in", HOUSEHOLDS).execute();
  await db.deleteFrom("household_recipe").where("household_id", "in", HOUSEHOLDS).execute();
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

/** Stamp a collection as published, without a PDS. Milestone 5 does this for real. */
async function markPublished(collectionId: string, did: string = DID_A): Promise<void> {
  await db!
    .updateTable("recipe_collection")
    .set({
      published_by_did: did,
      rkey: "3ktestcollection",
      uri: `at://${did}/exchange.recipe.collection/3ktestcollection`,
      cid: "bafytestcid",
      rev: "3ktestrev",
      published_at: sql`now()`,
      record_created_at: sql`now()`,
    })
    .where("id", "=", collectionId)
    .execute();
}

// --- suite ---------------------------------------------------------------

// The reason rides along in the suite name too, so a verbose reporter's
// "skipped" line says why without anyone hunting for the stderr note.
describe.skipIf(!db)(db ? "collections DB integration (§9)" : `collections DB integration (§9) — SKIPPED: ${skipReason}`, () => {
  beforeAll(async () => {
    collections = await import("./collections");
    box = await import("./household-recipes");

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
      .values([
        { id: R1, origin: "local", visibility: "public", name: "Shakshuka", uri: `at://${DID_A}/exchange.recipe.recipe/${R1}`, did: DID_A, rkey: R1 },
        { id: R2, origin: "local", visibility: "public", name: "Dal Tadka", uri: `at://${DID_A}/exchange.recipe.recipe/${R2}`, did: DID_A, rkey: R2 },
        { id: R3, origin: "local", visibility: "public", name: "Congee", uri: `at://${DID_A}/exchange.recipe.recipe/${R3}`, did: DID_A, rkey: R3 },
        { id: R_DRAFT, origin: "local", visibility: "draft", name: "Sunday Sauce" },
        { id: R_UNBOXED, origin: "local", visibility: "public", name: "Not In The Box", uri: `at://${DID_A}/exchange.recipe.recipe/${R_UNBOXED}`, did: DID_A },
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
      expect(await collections.patchCollection(db!, HH_A, { collectionId: id })).toEqual({ updated: false });
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
      expect(await collections.orderCollectionRecipes(db!, HH_B, { collectionId: id, orderedRecipeIds: [R2, R1] })).toEqual({ reordered: false });
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
      expect(result).toEqual({ ok: true, added: [R3, R1] });
      const rows = await entryRows(id);
      expect(rows.map((row) => row.recipe_id)).toEqual([R2, R3, R1]);
      expect(rows.map((row) => row.added_by_did)).toEqual([DID_A, DID_M, DID_M]);
      expectDense(rows);
    });

    it("ignores an already-filed recipe rather than moving it (§8)", async () => {
      const id = await makeCollection("Weeknights");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1, R2] });
      const result = await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1, R3] });
      expect(result).toEqual({ ok: true, added: [R3] });
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
      expect(result).toEqual({ ok: true, added: [R_DRAFT] });
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
      expect(await collections.unfileRecipeFromCollection(db!, HH_A, { collectionId: id, recipeId: R2 })).toEqual({ removed: true });
      const rows = await entryRows(id);
      expect(rows.map((row) => row.recipe_id)).toEqual([R1, R3]);
      expectDense(rows);
    });

    it("is idempotent", async () => {
      const id = await makeCollection("Weeknights");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1] });
      await collections.unfileRecipeFromCollection(db!, HH_A, { collectionId: id, recipeId: R1 });
      expect(await collections.unfileRecipeFromCollection(db!, HH_A, { collectionId: id, recipeId: R1 })).toEqual({ removed: false });
    });

    it("is inert for a collection in another household", async () => {
      const id = await makeCollection("Weeknights");
      await collections.fileRecipesIntoCollection(db!, DID_A, HH_A, { collectionId: id, recipeIds: [R1] });
      expect(await collections.unfileRecipeFromCollection(db!, HH_B, { collectionId: id, recipeId: R1 })).toEqual({ removed: false });
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

      expect(await collections.removeCollection(db!, HH_A, { collectionId: b })).toEqual({ deleted: true });
      const rows = await collectionRows(HH_A);
      expect(rows.map((row) => row.id)).toEqual([a, c]);
      expectDense(rows);
      expect(await entryRows(b)).toEqual([]);
    });

    it("is idempotent, and inert for another household's collection", async () => {
      const id = await makeCollection("A");
      expect(await collections.removeCollection(db!, HH_B, { collectionId: id })).toEqual({ deleted: false });
      expect(await collections.removeCollection(db!, HH_A, { collectionId: id })).toEqual({ deleted: true });
      expect(await collections.removeCollection(db!, HH_A, { collectionId: id })).toEqual({ deleted: false });
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
      expect(await box.unboxRecipe(db!, HH_A, R2)).toEqual({ unfiledFrom: [] });
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

      expect(await collections.patchCollection(db!, HH_B, { collectionId: id, name: "Stolen" })).toEqual({ updated: false });
      expect(await collections.orderCollectionRecipes(db!, HH_B, { collectionId: id, orderedRecipeIds: [R1] })).toEqual({ reordered: false });
      expect(await collections.unfileRecipeFromCollection(db!, HH_B, { collectionId: id, recipeId: R1 })).toEqual({ removed: false });
      expect(await collections.removeCollection(db!, HH_B, { collectionId: id })).toEqual({ deleted: false });
      await expect(collections.fileRecipesIntoCollection(db!, DID_B, HH_B, { collectionId: id, recipeIds: [R1] })).rejects.toThrow(/no longer exists/);

      const rows = await collectionRows(HH_A);
      expect(rows[0].name).toBe("Weeknights");
      expect(await entryRows(id)).toHaveLength(1);
    });

    it("lets a plain member write, but not delete", async () => {
      const { assertMember } = await import("./authz");
      const { InsufficientRoleError, NotAMemberError } = await import("./household/errors");

      // Members create, file and reorder.
      await expect(assertMember(DID_M, HH_A)).resolves.toMatchObject({ role: "member" });
      // Delete is the one role gate the handlers add (§2.8).
      await expect(assertMember(DID_M, HH_A, "owner")).rejects.toBeInstanceOf(InsufficientRoleError);
      await expect(assertMember(DID_A, HH_A, "owner")).resolves.toMatchObject({ role: "owner" });
      // And a non-member is nothing at all.
      await expect(assertMember(DID_B, HH_A)).rejects.toBeInstanceOf(NotAMemberError);
    });
  });
});
