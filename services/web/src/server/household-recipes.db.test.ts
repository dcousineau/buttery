import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "#/db/types";
import { ulid } from "./household/ids";

/**
 * DB-backed integration test for `readHouseholdRecipeDetail` — the §6.2 detail
 * read. It exists because that read is now ONE query whose child collections
 * are json sub-selects (`jsonArrayFrom`/`jsonObjectFrom`): the ordering, the
 * household scoping of the note, and the "absent child is null, not a row of
 * nulls" behaviour are properties of the SQL, so only a real Postgres can say
 * whether they hold. The membership join is asserted here too — it is the
 * authorization, so a non-member reading a boxed recipe must get `null`.
 *
 * Needs a real Postgres with migrations applied. Skips cleanly without one.
 */

// --- reachability probe --------------------------------------------------

function announceSkip(reason: string): void {
  process.stderr.write(`\nSKIPPING household-recipes DB tests — ${reason}.\nRun them against the local dev stack with \`pnpm test:db\`.\n\n`);
}

async function connectOrSkip(): Promise<Kysely<DB> | null> {
  if (!process.env.DATABASE_URL) {
    announceSkip("DATABASE_URL is not set");
    return null;
  }
  const { getDb } = await import("#/lib/db");
  const db = getDb();
  try {
    await Promise.race([
      sql`select 1 from household_recipe limit 0`.execute(db),
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

const RUN = ulid();

const HH = `hh-detail-${RUN}`;
const DID_MEMBER = `did:test:detail-member-${RUN}`;
const DID_STRANGER = `did:test:detail-stranger-${RUN}`;

const R_BOXED = `rec-detail-boxed-${RUN}`;
const R_UNBOXED = `rec-detail-unboxed-${RUN}`;
const RECIPES = [R_BOXED, R_UNBOXED];

type HouseholdRecipesModule = typeof import("./household-recipes");
let box: HouseholdRecipesModule;

async function cleanup(): Promise<void> {
  if (!db) return;
  await db.deleteFrom("household_recipe_note").where("household_id", "=", HH).execute();
  await db.deleteFrom("household_recipe").where("household_id", "=", HH).execute();
  await db.deleteFrom("recipe_ingredient").where("recipe_id", "in", RECIPES).execute();
  await db.deleteFrom("recipe_instruction").where("recipe_id", "in", RECIPES).execute();
  await db.deleteFrom("recipe_keyword").where("recipe_id", "in", RECIPES).execute();
  await db.deleteFrom("recipe").where("id", "in", RECIPES).execute();
  await db.deleteFrom("household_member").where("household_id", "=", HH).execute();
  await db.deleteFrom("household").where("id", "=", HH).execute();
}

async function reset(): Promise<void> {
  if (!db) return;
  await cleanup();
  await db.insertInto("household").values({ id: HH, name: "Detail Test", created_by_did: DID_MEMBER }).execute();
  await db.insertInto("household_member").values({ household_id: HH, did: DID_MEMBER, role: "owner", invited_by_did: null }).execute();
  await db
    .insertInto("recipe")
    .values([
      { id: R_BOXED, origin: "local", visibility: "public", name: "Boxed", did: DID_MEMBER, rkey: R_BOXED, total_time_seconds: 5400 },
      { id: R_UNBOXED, origin: "local", visibility: "public", name: "Unboxed", did: DID_MEMBER, rkey: R_UNBOXED },
    ])
    .execute();
  // Inserted out of order on purpose: the payload's order must come from the
  // sub-select's `order by ordinal`, not from insertion order.
  await db
    .insertInto("recipe_ingredient")
    .values([
      { recipe_id: R_BOXED, ordinal: 1, text: "2 eggs" },
      { recipe_id: R_BOXED, ordinal: 0, text: "1 cup flour" },
    ])
    .execute();
  await db
    .insertInto("recipe_instruction")
    .values([
      { recipe_id: R_BOXED, ordinal: 1, text: "Bake" },
      { recipe_id: R_BOXED, ordinal: 0, text: "Mix" },
    ])
    .execute();
  await db.insertInto("recipe_keyword").values({ recipe_id: R_BOXED, keyword: "brunch" }).execute();
  await db.insertInto("household_recipe").values({ household_id: HH, recipe_id: R_BOXED, added_by_did: DID_MEMBER, favorite: true }).execute();
}

beforeEach(async () => {
  if (!db) return;
  box = await import("./household-recipes");
  await reset();
});

afterAll(async () => {
  await cleanup();
  await db?.destroy().catch(() => {});
});

// --- tests ---------------------------------------------------------------

describe.skipIf(!db)(db ? "readHouseholdRecipeDetail (§6.2)" : "readHouseholdRecipeDetail (§6.2) — SKIPPED", () => {
  it("returns the recipe and every child collection in one payload, in ordinal order", async () => {
    const detail = await box.readHouseholdRecipeDetail(db!, DID_MEMBER, HH, R_BOXED);

    expect(detail).not.toBeNull();
    expect(detail!.title).toBe("Boxed");
    expect(detail!.favorite).toBe(true);
    expect(detail!.ingredients).toEqual(["1 cup flour", "2 eggs"]);
    expect(detail!.instructions).toEqual(["Mix", "Bake"]);
    expect(detail!.keywords).toEqual(["brunch"]);
    expect(detail!.totalTimeDisplay).toBe("1h 30m");
    // No image rows and no pending image: an absent child is an empty list or
    // a null, never a row of nulls conjured by a left join.
    expect(detail!.images).toEqual([]);
    expect(detail!.note).toBeNull();
  });

  it("reads the note of THIS household only", async () => {
    const other = `hh-detail-other-${RUN}`;
    await db!.insertInto("household").values({ id: other, name: "Other", created_by_did: DID_STRANGER }).execute();
    // The note's FK is the BOX row, so the other household must box it too —
    // which is exactly the collision this test is about.
    await db!.insertInto("household_recipe").values({ household_id: other, recipe_id: R_BOXED, added_by_did: DID_STRANGER }).execute();
    await db!
      .insertInto("household_recipe_note")
      .values([
        { household_id: HH, recipe_id: R_BOXED, author_did: DID_MEMBER, body: "ours" },
        { household_id: other, recipe_id: R_BOXED, author_did: DID_STRANGER, body: "theirs" },
      ])
      .execute();

    const detail = await box.readHouseholdRecipeDetail(db!, DID_MEMBER, HH, R_BOXED);
    expect(detail!.note?.body).toBe("ours");
    expect(Date.parse(detail!.note!.updatedAt)).not.toBeNaN();

    await db!.deleteFrom("household_recipe_note").where("household_id", "=", other).execute();
    await db!.deleteFrom("household_recipe").where("household_id", "=", other).execute();
    await db!.deleteFrom("household").where("id", "=", other).execute();
  });

  it("returns null for a non-member, for an unboxed recipe, and for an unknown recipe", async () => {
    expect(await box.readHouseholdRecipeDetail(db!, DID_STRANGER, HH, R_BOXED)).toBeNull();
    expect(await box.readHouseholdRecipeDetail(db!, DID_MEMBER, HH, R_UNBOXED)).toBeNull();
    expect(await box.readHouseholdRecipeDetail(db!, DID_MEMBER, HH, `rec-missing-${RUN}`)).toBeNull();
  });

  it("returns null once the membership is tombstoned", async () => {
    await db!.updateTable("household_member").set({ tombstoned: true }).where("household_id", "=", HH).where("did", "=", DID_MEMBER).execute();
    expect(await box.readHouseholdRecipeDetail(db!, DID_MEMBER, HH, R_BOXED)).toBeNull();
  });
});
