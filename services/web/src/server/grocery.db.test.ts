import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "#/db/types";
import { ulid } from "./household/ids";

/**
 * DB-backed integration tests for the grocery list (grocery-list plan §9).
 *
 * These exist for the claims that only a real Postgres can settle: the partial
 * unique index over live rows, D11's "a retired row never revives", the TTL
 * visibility window, and — the one that matters most — that every function is
 * scoped to its household. A cross-household leak is the failure mode a unit
 * test with a fake db can never rule out, so every read and every write is
 * exercised against a second household's id here.
 *
 * Skips silently without a database so `pnpm test` stays green; run against the
 * local stack with `DATABASE_URL` set (see `docs/CLAUDE_CLOUD.md`).
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
  process.stderr.write(`\nSKIPPING grocery DB tests — ${reason}.\nRun them against the local dev stack with DATABASE_URL set.\n\n`);
}

/**
 * Resolve a usable Kysely handle, or null. Probes for the grocery table too: a
 * database that is up but un-migrated would otherwise fail every test with an
 * unhelpful "relation does not exist".
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
      sql`select 1 from grocery_item limit 0`.execute(db),
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

const DID_A = `did:test:a-${RUN}`;
const DID_B = `did:test:b-${RUN}`;
const DIDS = [DID_A, DID_B];

const R_CHICKEN_LB = `rec-lb-${RUN}`;
const R_CHICKEN_OZ = `rec-oz-${RUN}`;
const R_UNBOXED = `rec-unboxed-${RUN}`;
const RECIPES = [R_CHICKEN_LB, R_CHICKEN_OZ, R_UNBOXED];

type Grocery = typeof import("./grocery");
let grocery: Grocery;

async function reset(): Promise<void> {
  if (!db) return;
  // Sources cascade from items, items from lists, but the order is explicit so
  // a partial failure leaves nothing dangling.
  await db
    .deleteFrom("grocery_item_source")
    .where("item_id", "in", (qb) => qb.selectFrom("grocery_item").select("id").where("household_id", "in", HOUSEHOLDS))
    .execute();
  await db.deleteFrom("grocery_item").where("household_id", "in", HOUSEHOLDS).execute();
  await db.deleteFrom("grocery_list").where("household_id", "in", HOUSEHOLDS).execute();
}

/** Live rows of a household's list, in insertion order. */
async function itemsOf(householdId: string) {
  if (!db) return [];
  return db
    .selectFrom("grocery_item")
    .select(["id", "food_slug", "name_norm", "display_name", "aisle", "quantity", "unit", "unit_dim", "merge_unit", "checked_at", "is_manual"])
    .where("household_id", "=", householdId)
    .orderBy("created_at")
    .execute();
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

/** Preview household A's two chicken recipes, then commit every row. */
async function addBothChickenRecipes(householdId = HH_A, did = DID_A) {
  const preview = await grocery.buildGroceryPreview(db!, did, householdId, {
    recipes: [{ recipeId: R_CHICKEN_LB }, { recipeId: R_CHICKEN_OZ }],
  });
  await grocery.commitGroceryRows(db!, did, householdId, { rows: preview.rows });
  return preview;
}

describe.skipIf(!db)(db ? "grocery list DB integration (§9)" : `grocery list DB integration (§9) — SKIPPED: ${skipReason}`, () => {
  beforeAll(async () => {
    grocery = await import("./grocery");

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
        { household_id: HH_B, did: DID_B, role: "owner", invited_by_did: null },
      ])
      .execute();
    await db!
      .insertInto("recipe")
      .values([
        { id: R_CHICKEN_LB, origin: "local", visibility: "public", name: "Roast Chicken" },
        { id: R_CHICKEN_OZ, origin: "local", visibility: "public", name: "Chicken Salad" },
        { id: R_UNBOXED, origin: "local", visibility: "public", name: "Not In The Box" },
      ])
      .execute();
    await db!
      .insertInto("recipe_ingredient")
      .values([
        // The plan's headline case, split across two recipes.
        { recipe_id: R_CHICKEN_LB, ordinal: 0, text: "1 lb chicken breast" },
        { recipe_id: R_CHICKEN_LB, ordinal: 1, text: "2 cloves garlic, minced" },
        { recipe_id: R_CHICKEN_LB, ordinal: 2, text: "Kosher salt, to taste" },
        { recipe_id: R_CHICKEN_LB, ordinal: 3, text: "4 cups water" },
        { recipe_id: R_CHICKEN_OZ, ordinal: 0, text: "8 oz chicken breast" },
        { recipe_id: R_CHICKEN_OZ, ordinal: 1, text: "3 cloves garlic" },
        { recipe_id: R_UNBOXED, ordinal: 0, text: "1 lb chicken breast" },
      ])
      .execute();
    await db!
      .insertInto("household_recipe")
      .values([
        { household_id: HH_A, recipe_id: R_CHICKEN_LB, added_by_did: DID_A },
        { household_id: HH_A, recipe_id: R_CHICKEN_OZ, added_by_did: DID_A },
        { household_id: HH_B, recipe_id: R_CHICKEN_LB, added_by_did: DID_B },
      ])
      .execute();
    await db!
      .insertInto("atproto_repo")
      .values({ did: DID_A, handle: `a-${RUN}.test` })
      .execute();
  });

  beforeEach(reset);

  afterAll(async () => {
    if (!db) return;
    await reset();
    await db.deleteFrom("recipe_ingredient").where("recipe_id", "in", RECIPES).execute();
    await db.deleteFrom("household_recipe").where("household_id", "in", HOUSEHOLDS).execute();
    await db.deleteFrom("recipe").where("id", "in", RECIPES).execute();
    await db.deleteFrom("household_member").where("household_id", "in", HOUSEHOLDS).execute();
    await db.deleteFrom("household").where("id", "in", HOUSEHOLDS).execute();
    await db.deleteFrom("atproto_repo").where("did", "in", DIDS).execute();
    await db.deleteFrom("household_member").where("did", "in", DIDS).execute();
    await db.destroy();
  });

  // --- CHECK constraints -------------------------------------------------

  describe("CHECK constraints reject malformed rows", () => {
    /** Bypasses every app-side validator on purpose — these are the DB's job. */
    async function insertRaw(values: Record<string, unknown>) {
      const listId = ulid();
      await db!
        .insertInto("grocery_list")
        .values({ id: listId, household_id: HH_A })
        .onConflict((oc) => oc.column("household_id").doNothing())
        .execute();
      const live = await db!.selectFrom("grocery_list").select("id").where("household_id", "=", HH_A).executeTakeFirstOrThrow();
      return db!
        .insertInto("grocery_item")
        .values({
          id: ulid(),
          household_id: HH_A,
          list_id: live.id,
          name_norm: "thing",
          display_name: "Thing",
          aisle: "produce",
          created_by_did: DID_A,
          ...values,
        })
        .execute();
    }

    it("rejects an unknown aisle", async () => {
      const error = await expectRejects(() => insertRaw({ aisle: "seasonal_gourds" }));
      expect(error.code).toBe("23514");
      expect(error.constraint).toBe("grocery_item_aisle_check");
    });

    it("rejects an unknown unit dimension", async () => {
      const error = await expectRejects(() => insertRaw({ unit_dim: "furlongs" }));
      expect(error.code).toBe("23514");
      expect(error.constraint).toBe("grocery_item_unit_dim_check");
    });

    it("allows a null unit dimension, which is what an unparsed line has", async () => {
      await expect(insertRaw({ unit_dim: null })).resolves.not.toThrow();
    });
  });

  // --- one list per household --------------------------------------------

  describe("one running list per household (D1)", () => {
    it("creates the list on first commit and reuses it after", async () => {
      await addBothChickenRecipes();
      await addBothChickenRecipes();

      const lists = await db!.selectFrom("grocery_list").select("id").where("household_id", "=", HH_A).execute();
      expect(lists).toHaveLength(1);
    });

    it("refuses a second list row outright", async () => {
      await db!.insertInto("grocery_list").values({ id: ulid(), household_id: HH_A }).execute();
      const error = await expectRejects(() => db!.insertInto("grocery_list").values({ id: ulid(), household_id: HH_A }).execute());
      expect(error.code).toBe("23505");
    });
  });

  // --- the headline case, through the database ---------------------------

  describe("consolidation end to end", () => {
    it("merges 1 lb and 8 oz of chicken breast into ONE row naming both recipes", async () => {
      await addBothChickenRecipes();

      const items = await itemsOf(HH_A);
      const chicken = items.filter((item) => item.food_slug === "en:chicken-breast");
      expect(chicken).toHaveLength(1);
      // 1 lb + 8 oz, in grams.
      expect(Number(chicken[0].quantity)).toBeCloseTo(453.59237 + 8 * 28.349523, 2);
      expect(chicken[0].aisle).toBe("meat_seafood");

      const sources = await db!.selectFrom("grocery_item_source").select(["recipe_id", "raw_text"]).where("item_id", "=", chicken[0].id).orderBy("added_at").execute();
      const byId = (a: string | null, b: string | null) => String(a).localeCompare(String(b));
      expect(sources.map((s) => s.recipe_id).sort(byId)).toEqual([R_CHICKEN_LB, R_CHICKEN_OZ].sort(byId));
      // The verbatim lines are snapshotted, so the row survives its recipe.
      expect(sources.map((s) => s.raw_text).sort(byId)).toEqual(["1 lb chicken breast", "8 oz chicken breast"]);
    });

    it("drops ignored lines and keeps staples", async () => {
      const preview = await addBothChickenRecipes();
      // "4 cups water" never reaches the preview at all.
      expect(preview.rows.some((row) => row.nameNorm === "water")).toBe(false);
      // Salt does, flagged as a staple so the dialog can leave it unchecked.
      expect(preview.rows.some((row) => row.isStaple)).toBe(true);
    });

    it("re-adding the same recipes merges into the existing rows rather than duplicating", async () => {
      await addBothChickenRecipes();
      const before = await itemsOf(HH_A);
      await addBothChickenRecipes();
      const after = await itemsOf(HH_A);

      expect(after).toHaveLength(before.length);
      const chicken = after.find((item) => item.food_slug === "en:chicken-breast")!;
      expect(Number(chicken.quantity)).toBeCloseTo(2 * (453.59237 + 8 * 28.349523), 2);
    });

    it("reports which live row a preview row would merge into", async () => {
      await addBothChickenRecipes();
      const preview = await grocery.buildGroceryPreview(db!, DID_A, HH_A, { recipes: [{ recipeId: R_CHICKEN_LB }] });
      const chicken = preview.rows.find((row) => row.foodSlug === "en:chicken-breast")!;
      expect(chicken.mergesInto).toEqual(expect.any(String));
    });
  });

  // --- scale --------------------------------------------------------------

  describe("scale (D4)", () => {
    it("multiplies contributed quantities and records the factor on the source", async () => {
      const preview = await grocery.buildGroceryPreview(db!, DID_A, HH_A, { recipes: [{ recipeId: R_CHICKEN_LB, scale: 2 }] });
      await grocery.commitGroceryRows(db!, DID_A, HH_A, { rows: preview.rows });

      const chicken = (await itemsOf(HH_A)).find((item) => item.food_slug === "en:chicken-breast")!;
      expect(Number(chicken.quantity)).toBeCloseTo(453.59237 * 2, 2);

      const source = await db!.selectFrom("grocery_item_source").select("scale").where("item_id", "=", chicken.id).executeTakeFirstOrThrow();
      expect(Number(source.scale)).toBe(2);
    });

    it("writes nothing back to the recipe", async () => {
      const preview = await grocery.buildGroceryPreview(db!, DID_A, HH_A, { recipes: [{ recipeId: R_CHICKEN_LB, scale: 3 }] });
      await grocery.commitGroceryRows(db!, DID_A, HH_A, { rows: preview.rows });

      const lines = await db!.selectFrom("recipe_ingredient").select("text").where("recipe_id", "=", R_CHICKEN_LB).orderBy("ordinal").execute();
      expect(lines[0].text).toBe("1 lb chicken breast");
    });
  });

  // --- the live-row unique index, and D11 --------------------------------

  describe("the live-row partial unique index (D11)", () => {
    it("refuses a second LIVE row for the same identity", async () => {
      await addBothChickenRecipes();
      const chicken = (await itemsOf(HH_A)).find((item) => item.food_slug === "en:chicken-breast")!;
      const list = await db!.selectFrom("grocery_list").select("id").where("household_id", "=", HH_A).executeTakeFirstOrThrow();

      const error = await expectRejects(() =>
        db!
          .insertInto("grocery_item")
          .values({
            id: ulid(),
            household_id: HH_A,
            list_id: list.id,
            food_slug: chicken.food_slug,
            name_norm: chicken.name_norm,
            display_name: "Chicken again",
            aisle: "meat_seafood",
            unit_dim: chicken.unit_dim,
            merge_unit: chicken.merge_unit,
            created_by_did: DID_A,
          })
          .execute(),
      );
      expect(error.code).toBe("23505");
      expect(error.constraint).toBe("grocery_item_live_identity_key");
    });

    it("re-adding a food whose row is RETIRED creates a new row instead of reviving it", async () => {
      await addBothChickenRecipes();
      const first = (await itemsOf(HH_A)).find((item) => item.food_slug === "en:chicken-breast")!;

      await grocery.setGroceryItemChecked(db!, DID_A, HH_A, { itemId: first.id, checked: true });
      await addBothChickenRecipes();

      const chicken = (await itemsOf(HH_A)).filter((item) => item.food_slug === "en:chicken-breast");
      expect(chicken).toHaveLength(2);
      // The retired row keeps its own total; nothing was re-totalled into it.
      const retired = chicken.find((item) => item.id === first.id)!;
      const fresh = chicken.find((item) => item.id !== first.id)!;
      expect(retired.checked_at).not.toBeNull();
      expect(fresh.checked_at).toBeNull();
      expect(Number(fresh.quantity)).toBeCloseTo(453.59237 + 8 * 28.349523, 2);
    });

    it("keeps two different unit dimensions of the same food as two live rows (D5)", async () => {
      await addBothChickenRecipes();
      const list = await db!.selectFrom("grocery_list").select("id").where("household_id", "=", HH_A).executeTakeFirstOrThrow();

      // Same food, `count` instead of `mass` — legal, and a separate row.
      await expect(
        db!
          .insertInto("grocery_item")
          .values({
            id: ulid(),
            household_id: HH_A,
            list_id: list.id,
            food_slug: "en:chicken-breast",
            name_norm: "chicken breast",
            display_name: "2 chicken breasts",
            aisle: "meat_seafood",
            quantity: 2,
            unit_dim: "count",
            created_by_did: DID_A,
          })
          .execute(),
      ).resolves.not.toThrow();
    });
  });

  // --- TTL visibility (D10) ----------------------------------------------

  describe("checked rows retire from the default view (D10)", () => {
    it("keeps a freshly checked row in the read", async () => {
      await addBothChickenRecipes();
      const chicken = (await itemsOf(HH_A)).find((item) => item.food_slug === "en:chicken-breast")!;
      await grocery.setGroceryItemChecked(db!, DID_A, HH_A, { itemId: chicken.id, checked: true });

      const payload = await grocery.readGroceryList(db!, DID_A, HH_A);
      const row = payload.items.find((item) => item.id === chicken.id);
      expect(row).toBeTruthy();
      expect(row!.checkedAt).not.toBeNull();
      expect(row!.checkedByHandle).toBe(`@a-${RUN}.test`);
    });

    it("drops a row checked longer ago than the TTL, without deleting it", async () => {
      await addBothChickenRecipes();
      const chicken = (await itemsOf(HH_A)).find((item) => item.food_slug === "en:chicken-breast")!;
      await db!
        .updateTable("grocery_item")
        .set({ checked_at: sql`now() - interval '2 hours'`, checked_by_did: DID_A })
        .where("id", "=", chicken.id)
        .execute();

      const payload = await grocery.readGroceryList(db!, DID_A, HH_A);
      expect(payload.items.find((item) => item.id === chicken.id)).toBeUndefined();

      // Still in the table as history — nothing is deleted and no cron runs.
      const still = await db!.selectFrom("grocery_item").select("id").where("id", "=", chicken.id).executeTakeFirst();
      expect(still).toBeTruthy();
    });

    it("hands the client server time and the TTL so it can apply the same cutoff", async () => {
      const payload = await grocery.readGroceryList(db!, DID_A, HH_A);
      expect(payload.checkedTtlSeconds).toBe(grocery.CHECKED_TTL_SECONDS);
      expect(Date.parse(payload.readAt)).not.toBeNaN();
    });

    it("unchecking restores a row", async () => {
      await addBothChickenRecipes();
      const chicken = (await itemsOf(HH_A)).find((item) => item.food_slug === "en:chicken-breast")!;
      await grocery.setGroceryItemChecked(db!, DID_A, HH_A, { itemId: chicken.id, checked: true });
      const result = await grocery.setGroceryItemChecked(db!, DID_A, HH_A, { itemId: chicken.id, checked: false });
      expect(result.checkedAt).toBeNull();
    });
  });

  // --- manual items -------------------------------------------------------

  describe("manual items", () => {
    it("parses, categorizes and flags a typed line", async () => {
      await grocery.addManualItem(db!, DID_A, HH_A, { text: "2 lbs chicken breast" });
      const items = await itemsOf(HH_A);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ food_slug: "en:chicken-breast", aisle: "meat_seafood", is_manual: true });
    });

    it("honours a typed line that a recipe's would have been ignored", async () => {
      await grocery.addManualItem(db!, DID_A, HH_A, { text: "sparkling water" });
      expect(await itemsOf(HH_A)).toHaveLength(1);
    });

    it("merges a typed line into a matching live row", async () => {
      await addBothChickenRecipes();
      const before = (await itemsOf(HH_A)).length;
      const result = await grocery.addManualItem(db!, DID_A, HH_A, { text: "8 oz chicken breast" });
      expect(result.merged).toBe(true);
      expect(await itemsOf(HH_A)).toHaveLength(before);
    });

    it("refuses an empty line", async () => {
      await expect(grocery.addManualItem(db!, DID_A, HH_A, { text: "   " })).rejects.toThrow();
    });
  });

  // --- edit and remove ----------------------------------------------------

  describe("edit and remove", () => {
    it("renames without moving the row's identity", async () => {
      await addBothChickenRecipes();
      const chicken = (await itemsOf(HH_A)).find((item) => item.food_slug === "en:chicken-breast")!;
      await grocery.editGroceryItem(db!, DID_A, HH_A, { itemId: chicken.id, displayName: "Chicken for Sunday" });

      const after = (await itemsOf(HH_A)).find((item) => item.id === chicken.id)!;
      expect(after.display_name).toBe("Chicken for Sunday");
      expect(after.name_norm).toBe(chicken.name_norm);
      expect(after.food_slug).toBe(chicken.food_slug);
    });

    it("removes a row and its sources", async () => {
      await addBothChickenRecipes();
      const chicken = (await itemsOf(HH_A)).find((item) => item.food_slug === "en:chicken-breast")!;
      const result = await grocery.deleteGroceryItem(db!, DID_A, HH_A, { itemId: chicken.id });
      expect(result.removed).toBe(true);

      const sources = await db!.selectFrom("grocery_item_source").select("id").where("item_id", "=", chicken.id).execute();
      expect(sources).toHaveLength(0);
    });

    it("clears every checked row at once", async () => {
      await addBothChickenRecipes();
      const items = await itemsOf(HH_A);
      await grocery.setGroceryItemChecked(db!, DID_A, HH_A, { itemId: items[0].id, checked: true });

      const result = await grocery.clearCheckedItems(db!, DID_A, HH_A);
      expect(result.removed).toBe(1);
      expect(await itemsOf(HH_A)).toHaveLength(items.length - 1);
    });
  });

  // --- cross-household isolation -----------------------------------------

  describe("cross-household isolation, on every function", () => {
    it("previewing refuses a recipe that is not in the caller's box", async () => {
      await expect(grocery.buildGroceryPreview(db!, DID_A, HH_A, { recipes: [{ recipeId: R_UNBOXED }] })).rejects.toThrow(/not in this household/i);
    });

    it("previewing refuses a recipe boxed by ANOTHER household", async () => {
      // R_CHICKEN_OZ is in A's box only; B must not be able to preview it.
      await expect(grocery.buildGroceryPreview(db!, DID_B, HH_B, { recipes: [{ recipeId: R_CHICKEN_OZ }] })).rejects.toThrow(/not in this household/i);
    });

    it("reading returns only the caller's household's list", async () => {
      await addBothChickenRecipes(HH_A, DID_A);
      const preview = await grocery.buildGroceryPreview(db!, DID_B, HH_B, { recipes: [{ recipeId: R_CHICKEN_LB }] });
      await grocery.commitGroceryRows(db!, DID_B, HH_B, { rows: preview.rows });

      const a = await grocery.readGroceryList(db!, DID_A, HH_A);
      const b = await grocery.readGroceryList(db!, DID_B, HH_B);

      expect(a.listId).not.toBe(b.listId);
      const aChicken = a.items.find((item) => item.foodSlug === "en:chicken-breast")!;
      const bChicken = b.items.find((item) => item.foodSlug === "en:chicken-breast")!;
      // A has 1 lb + 8 oz; B has only 1 lb. Neither can see the other's total.
      expect(aChicken.quantity).toBeCloseTo(453.59237 + 8 * 28.349523, 2);
      expect(bChicken.quantity).toBeCloseTo(453.59237, 2);
    });

    it("checking off is inert against another household's item id", async () => {
      await addBothChickenRecipes(HH_A, DID_A);
      const chicken = (await itemsOf(HH_A)).find((item) => item.food_slug === "en:chicken-breast")!;

      await expect(grocery.setGroceryItemChecked(db!, DID_B, HH_B, { itemId: chicken.id, checked: true })).rejects.toThrow();

      const after = (await itemsOf(HH_A)).find((item) => item.id === chicken.id)!;
      expect(after.checked_at).toBeNull();
    });

    it("editing is inert against another household's item id", async () => {
      await addBothChickenRecipes(HH_A, DID_A);
      const chicken = (await itemsOf(HH_A)).find((item) => item.food_slug === "en:chicken-breast")!;

      await expect(grocery.editGroceryItem(db!, DID_B, HH_B, { itemId: chicken.id, displayName: "pwned" })).rejects.toThrow();

      const after = (await itemsOf(HH_A)).find((item) => item.id === chicken.id)!;
      expect(after.display_name).not.toBe("pwned");
    });

    it("removing is inert against another household's item id", async () => {
      await addBothChickenRecipes(HH_A, DID_A);
      const chicken = (await itemsOf(HH_A)).find((item) => item.food_slug === "en:chicken-breast")!;

      const result = await grocery.deleteGroceryItem(db!, DID_B, HH_B, { itemId: chicken.id });
      expect(result.removed).toBe(false);
      expect((await itemsOf(HH_A)).find((item) => item.id === chicken.id)).toBeTruthy();
    });

    it("clearing checked rows never reaches another household", async () => {
      await addBothChickenRecipes(HH_A, DID_A);
      const items = await itemsOf(HH_A);
      await grocery.setGroceryItemChecked(db!, DID_A, HH_A, { itemId: items[0].id, checked: true });

      const result = await grocery.clearCheckedItems(db!, DID_B, HH_B);
      expect(result.removed).toBe(0);
      expect(await itemsOf(HH_A)).toHaveLength(items.length);
    });

    it("a manual item lands only on the caller's list", async () => {
      await grocery.addManualItem(db!, DID_A, HH_A, { text: "1 lb chicken breast" });
      expect(await itemsOf(HH_B)).toHaveLength(0);
    });
  });
});
