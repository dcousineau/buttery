import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "#/db/types";
import { ulid } from "./ids";

/**
 * DB-backed integration tests for the Autoimport My Recipes feature:
 * - `importMemberRecipes` adds a member's public recipes to the household box
 *   when the preference is on, and only public recipes.
 * - `unboxRecipe` refuses to remove a recipe whose publisher is a live member
 *   with autoimport on.
 *
 * Needs a real Postgres with migrations applied. Skips cleanly without one.
 */

// --- reachability probe --------------------------------------------------

function announceSkip(reason: string): void {
  process.stderr.write(`\nSKIPPING household autoimport DB tests — ${reason}.\nRun them against the local dev stack with \`pnpm test:db\`.\n\n`);
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
      sql`select 1 from household_member limit 0`.execute(db),
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

const HH = `hh-autoimport-${RUN}`;
const DID_OWNER = `did:test:autoimport-owner-${RUN}`;
const DID_MEMBER = `did:test:autoimport-member-${RUN}`;
const DID_STRANGER = `did:test:autoimport-stranger-${RUN}`;

const R_PUBLIC = `rec-autoimport-public-${RUN}`;
const R_PRIVATE = `rec-autoimport-private-${RUN}`;
const R_DRAFT = `rec-autoimport-draft-${RUN}`;
const RECIPES = [R_PUBLIC, R_PRIVATE, R_DRAFT];

type AutoimportModule = typeof import("./autoimport");
type HouseholdRecipesModule = typeof import("../household-recipes");
let autoimport: AutoimportModule;
let box: HouseholdRecipesModule;

async function cleanup(): Promise<void> {
  if (!db) return;
  await db.deleteFrom("household_recipe").where("household_id", "=", HH).execute();
  await db.deleteFrom("recipe").where("id", "in", RECIPES).execute();
  await db.deleteFrom("household_member").where("household_id", "=", HH).execute();
  await db.deleteFrom("household").where("id", "=", HH).execute();
}

async function reset(): Promise<void> {
  if (!db) return;
  await cleanup();
  await db.insertInto("household").values({ id: HH, name: "Autoimport Test", created_by_did: DID_OWNER }).execute();
  await db
    .insertInto("recipe")
    .values([
      { id: R_PUBLIC, origin: "local", visibility: "public", name: "Public", did: DID_MEMBER, rkey: R_PUBLIC },
      { id: R_PRIVATE, origin: "local", visibility: "private", name: "Private", did: DID_MEMBER, rkey: R_PRIVATE },
      { id: R_DRAFT, origin: "local", visibility: "draft", name: "Draft", did: DID_MEMBER, rkey: R_DRAFT },
    ])
    .execute();
}

beforeEach(async () => {
  if (!db) return;
  autoimport = await import("./autoimport");
  box = await import("../household-recipes");
  await reset();
});

afterAll(async () => {
  await cleanup();
  await db?.destroy().catch(() => {});
});

// --- tests ---------------------------------------------------------------

describe.skipIf(!db)(db ? "household autoimport DB integration" : `household autoimport DB integration — SKIPPED`, () => {
  it("imports only public recipes when autoimport is on", async () => {
    await db!.insertInto("household_member").values({ household_id: HH, did: DID_MEMBER, role: "member", invited_by_did: DID_OWNER, autoimport_my_recipes: true }).execute();

    const result = await autoimport.importMemberRecipes(db!, HH, DID_MEMBER);
    expect(result.added).toBe(1);

    const boxed = await db!.selectFrom("household_recipe").select("recipe_id").where("household_id", "=", HH).execute();
    expect(boxed.map((r) => r.recipe_id)).toEqual([R_PUBLIC]);
  });

  it("imports nothing when autoimport is off", async () => {
    await db!.insertInto("household_member").values({ household_id: HH, did: DID_MEMBER, role: "member", invited_by_did: DID_OWNER, autoimport_my_recipes: false }).execute();

    const result = await autoimport.importMemberRecipes(db!, HH, DID_MEMBER);
    expect(result.added).toBe(0);

    const boxed = await db!.selectFrom("household_recipe").select("recipe_id").where("household_id", "=", HH).execute();
    expect(boxed).toHaveLength(0);
  });

  it("imports nothing for a recipe published by a non-member", async () => {
    await db!.insertInto("household_member").values({ household_id: HH, did: DID_OWNER, role: "owner", invited_by_did: null, autoimport_my_recipes: true }).execute();

    const result = await autoimport.importMemberRecipes(db!, HH, DID_STRANGER);
    expect(result.added).toBe(0);
  });

  it("blocks removing a recipe published by a member with autoimport on", async () => {
    await db!.insertInto("household_member").values({ household_id: HH, did: DID_MEMBER, role: "member", invited_by_did: DID_OWNER, autoimport_my_recipes: true }).execute();
    await autoimport.importMemberRecipes(db!, HH, DID_MEMBER);

    await expect(box.unboxRecipe(db!, HH, R_PUBLIC)).rejects.toMatchObject({ code: "autoimport_protected" });
  });

  it("names the pinning member so the UI can disable Remove before it is pressed", async () => {
    await db!.insertInto("household_member").values({ household_id: HH, did: DID_MEMBER, role: "member", invited_by_did: DID_OWNER, autoimport_my_recipes: true }).execute();
    await autoimport.importMemberRecipes(db!, HH, DID_MEMBER);

    expect(await autoimport.autoimportPinnedBy(db!, HH, R_PUBLIC)).toBe(DID_MEMBER);
  });

  it("reports no pin for a recipe whose publisher has autoimport off", async () => {
    await db!.insertInto("household_member").values({ household_id: HH, did: DID_MEMBER, role: "member", invited_by_did: DID_OWNER, autoimport_my_recipes: false }).execute();

    expect(await autoimport.autoimportPinnedBy(db!, HH, R_PUBLIC)).toBeNull();
  });

  it("allows removing a recipe published by a member with autoimport off", async () => {
    await db!.insertInto("household_member").values({ household_id: HH, did: DID_MEMBER, role: "member", invited_by_did: DID_OWNER, autoimport_my_recipes: false }).execute();
    await db!.insertInto("household_recipe").values({ household_id: HH, recipe_id: R_PUBLIC, added_by_did: DID_MEMBER }).execute();

    const result = await box.unboxRecipe(db!, HH, R_PUBLIC);
    expect(result.unfiledFrom).toEqual([]);
  });
});
