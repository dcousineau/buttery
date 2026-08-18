import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
}

/** Live rows of a household's list, in insertion order. */
async function itemsOf(householdId: string) {
  if (!db) return [];
  return db
    .selectFrom("grocery_item")
    .select(["id", "food_slug", "name_norm", "display_name", "aisle", "quantity", "unit", "unit_dim", "merge_unit", "checked_at", "cleared_at", "is_manual"])
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
      return db!
        .insertInto("grocery_item")
        .values({
          id: ulid(),
          household_id: HH_A,
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

  describe("the household IS the list (D1)", () => {
    it("reads an empty list for a household that has never added anything, and creates nothing", async () => {
      // There is no `grocery_list` row to find or mint: a household with an
      // empty list is one with no `grocery_item` rows. This used to short
      // circuit on a missing list row; now the query simply comes back empty.
      const payload = await grocery.readGroceryList(db!, DID_B, HH_B);
      expect(payload.items).toEqual([]);
      expect(await itemsOf(HH_B)).toHaveLength(0);
    });

    it("accumulates every add onto the one set of household rows", async () => {
      await addBothChickenRecipes();
      const first = await itemsOf(HH_A);
      await addBothChickenRecipes();
      const second = await itemsOf(HH_A);

      // Same rows, re-totalled — a second add cannot fork a household's list,
      // because there is nothing for it to fork into.
      expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
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

  // --- a plan week -------------------------------------------------------

  describe("a plan week contributes once per entry", () => {
    const WEEK = "2026-03-02";

    async function planRecipe(recipeId: string, planDate: string, slot: string, position: number): Promise<string> {
      const id = ulid();
      await db!
        .insertInto("meal_plan_entry")
        .values({ id, household_id: HH_A, plan_date: planDate, slot, position, kind: "recipe", recipe_id: recipeId, created_by_did: DID_A })
        .execute();
      return id;
    }

    it("counts a recipe planned twice in the week twice", async () => {
      // Two dinners of the same roast chicken is two pounds of chicken. A week
      // deduplicated by recipe id would send you home with one.
      const first = await planRecipe(R_CHICKEN_LB, "2026-03-02", "dinner", 0);
      const second = await planRecipe(R_CHICKEN_LB, "2026-03-05", "dinner", 0);

      const preview = await grocery.buildGroceryPreview(db!, DID_A, HH_A, { planWeek: WEEK });
      const chicken = preview.rows.find((row) => row.foodSlug === "en:chicken-breast")!;
      expect(chicken.quantity).toBeCloseTo(453.59237 * 2, 2);

      // And each contribution names the entry it came from.
      expect(new Set(chicken.sources.map((source) => source.planEntryId))).toEqual(new Set([first, second]));

      await grocery.commitGroceryRows(db!, DID_A, HH_A, { rows: preview.rows });
      const item = (await itemsOf(HH_A)).find((row) => row.food_slug === "en:chicken-breast")!;
      const sources = await db!.selectFrom("grocery_item_source").select("plan_entry_id").where("item_id", "=", item.id).execute();
      expect(new Set(sources.map((source) => source.plan_entry_id))).toEqual(new Set([first, second]));
    });

    it("lets an explicit entry replace the week's copies of that recipe rather than doubling them", async () => {
      await planRecipe(R_CHICKEN_LB, "2026-03-02", "dinner", 0);

      const preview = await grocery.buildGroceryPreview(db!, DID_A, HH_A, { planWeek: WEEK, recipes: [{ recipeId: R_CHICKEN_LB, scale: 2 }] });
      const chicken = preview.rows.find((row) => row.foodSlug === "en:chicken-breast")!;
      expect(chicken.quantity).toBeCloseTo(453.59237 * 2, 2);
      expect(preview.recipes).toHaveLength(1);
    });

    afterEach(async () => {
      await db!.deleteFrom("meal_plan_entry").where("household_id", "in", HOUSEHOLDS).execute();
    });
  });

  // --- the live-row unique index, and D11 --------------------------------

  describe("the live-row partial unique index (D11)", () => {
    it("refuses a second LIVE row for the same identity", async () => {
      await addBothChickenRecipes();
      const chicken = (await itemsOf(HH_A)).find((item) => item.food_slug === "en:chicken-breast")!;

      const error = await expectRejects(() =>
        db!
          .insertInto("grocery_item")
          .values({
            id: ulid(),
            household_id: HH_A,
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

    it("consolidates two simultaneous adds of a food nobody has yet", async () => {
      // Two shoppers, same second, same food, no live row to lock: `for update`
      // finds nothing and Postgres gap-locks nothing, so without the commit's
      // advisory lock both transactions reach the insert and one dies on
      // `grocery_item_live_identity_key` instead of merging.
      const [a, b] = await Promise.all([
        grocery.buildGroceryPreview(db!, DID_A, HH_A, { recipes: [{ recipeId: R_CHICKEN_LB }] }),
        grocery.buildGroceryPreview(db!, DID_A, HH_A, { recipes: [{ recipeId: R_CHICKEN_OZ }] }),
      ]);

      await Promise.all([grocery.commitGroceryRows(db!, DID_A, HH_A, { rows: a.rows }), grocery.commitGroceryRows(db!, DID_A, HH_A, { rows: b.rows })]);

      const chicken = (await itemsOf(HH_A)).filter((item) => item.food_slug === "en:chicken-breast");
      expect(chicken).toHaveLength(1);
      expect(Number(chicken[0].quantity)).toBeCloseTo(453.59237 + 8 * 28.349523, 2);
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

      // Same food, `count` instead of `mass` — legal, and a separate row.
      await expect(
        db!
          .insertInto("grocery_item")
          .values({
            id: ulid(),
            household_id: HH_A,
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

  // --- stable order (the bug: checking a box reshuffled the list) ---------

  describe("read order is stable across writes", () => {
    /**
     * The regression these pin:
     *
     * `created_at` defaults to `now()`, which in Postgres is the TRANSACTION
     * timestamp — so every row one `commitGroceryRows` call writes carries a
     * byte-identical stamp. `ORDER BY created_at` alone leaves the whole batch
     * tied, the planner is free to return ties in heap order, and an UPDATE
     * rewrites the row to a new physical location. Checking a box is an UPDATE,
     * so ticking one item reordered every other one. An `id` tiebreaker fixes it.
     *
     * Rows are seeded here rather than added through `commitGroceryRows` for two
     * reasons. One transaction with an explicit multi-row insert guarantees the
     * tie the bug needs, instead of hoping for it. And the ids are minted from
     * timestamps a second apart, which makes the expected order a fact of the
     * fixture: the repo's `ulid()` time-prefixes to the millisecond but fills the
     * rest with plain randomness (it is NOT the spec's monotonic variant), so ids
     * minted inside one millisecond sort randomly against each other and
     * "insertion order" would otherwise be an assertion about the clock.
     */
    async function seedTiedRows(count = 8): Promise<string[]> {
      const base = Date.now();
      const ids = Array.from({ length: count }, (_, index) => ulid(base + index * 1000));
      await db!.transaction().execute(async (trx) => {
        await trx
          .insertInto("grocery_item")
          .values(
            ids.map((id, index) => ({
              id,
              household_id: HH_A,
              name_norm: `thing-${index}`,
              display_name: `Thing ${index}`,
              aisle: "produce",
              created_by_did: DID_A,
            })),
          )
          .execute();
      });

      // If the seed did not actually tie, the tests below prove nothing.
      const stamps = await db!.selectFrom("grocery_item").select("created_at").where("household_id", "=", HH_A).execute();
      expect(new Set(stamps.map((row) => String(row.created_at))).size).toBe(1);
      return ids;
    }

    const readIds = async () => (await grocery.readGroceryList(db!, DID_A, HH_A)).items.map((item) => item.id);

    it("returns tied rows in insertion order, and keeps it when one is checked off", async () => {
      const ids = await seedTiedRows();
      expect(await readIds()).toEqual(ids);

      // A row in the middle — checking it is what used to fling it to the end.
      await grocery.setGroceryItemChecked(db!, DID_A, HH_A, { itemId: ids[3], checked: true });
      expect(await readIds()).toEqual(ids);

      // Unchecking puts it back where it was, too.
      await grocery.setGroceryItemChecked(db!, DID_A, HH_A, { itemId: ids[3], checked: false });
      expect(await readIds()).toEqual(ids);
    });

    it("holds that order through repeated toggling, which moves rows between heap pages", async () => {
      const ids = await seedTiedRows();

      for (let pass = 0; pass < 15; pass += 1) {
        for (const id of ids.slice(1, 4)) {
          await grocery.setGroceryItemChecked(db!, DID_A, HH_A, { itemId: id, checked: true });
          await grocery.setGroceryItemChecked(db!, DID_A, HH_A, { itemId: id, checked: false });
        }
      }

      expect(await readIds()).toEqual(ids);
    });

    it("holds that order through an edit, which is the same UPDATE in a different shirt", async () => {
      const ids = await seedTiedRows();
      await grocery.editGroceryItem(db!, DID_A, HH_A, { itemId: ids[2], displayName: "Renamed" });
      await grocery.editGroceryItem(db!, DID_A, HH_A, { itemId: ids[6], quantity: 3 });
      expect(await readIds()).toEqual(ids);
    });

    /**
     * `insertSources` writes every source of an item in ONE multi-row insert, so
     * `added_at` ties exactly the same way `created_at` does and needs the same
     * tiebreaker.
     */
    it("keeps an item's sources in a stable order across a write", async () => {
      await addBothChickenRecipes();
      const before = (await grocery.readGroceryList(db!, DID_A, HH_A)).items.find((item) => item.foodSlug === "en:chicken-breast")!;
      expect(before.sources).toHaveLength(2);

      await grocery.setGroceryItemChecked(db!, DID_A, HH_A, { itemId: before.id, checked: true });
      const after = (await grocery.readGroceryList(db!, DID_A, HH_A)).items.find((item) => item.id === before.id)!;
      expect(after.sources.map((source) => source.rawText)).toEqual(before.sources.map((source) => source.rawText));
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

    it("clearing the purchased items keeps them — off the list, still in the table", async () => {
      await addBothChickenRecipes();
      const items = await itemsOf(HH_A);
      await grocery.setGroceryItemChecked(db!, DID_A, HH_A, { itemId: items[0].id, checked: true });

      const result = await grocery.clearPurchasedItems(db!, DID_A, HH_A);
      expect(result.cleared).toBe(1);

      // The row survives — this is the promise the schema header makes about
      // checked rows — but the list stops reading it.
      const after = await itemsOf(HH_A);
      expect(after).toHaveLength(items.length);
      expect(after.find((item) => item.id === items[0].id)!.cleared_at).not.toBeNull();

      const list = await grocery.readGroceryList(db!, DID_A, HH_A);
      expect(list.items.map((item) => item.id)).not.toContain(items[0].id);
      expect(list.items).toHaveLength(items.length - 1);
    });

    it("clearing the purchased items leaves the unchecked ones alone", async () => {
      await addBothChickenRecipes();
      const items = await itemsOf(HH_A);
      expect(items.length).toBeGreaterThan(1);

      // Nothing checked: the end-of-trip sweep has nothing to sweep, and must
      // not quietly become "clear all".
      const result = await grocery.clearPurchasedItems(db!, DID_A, HH_A);
      expect(result.cleared).toBe(0);
      expect((await grocery.readGroceryList(db!, DID_A, HH_A)).items).toHaveLength(items.length);
    });

    it("clearing all takes the unchecked rows too, without claiming they were bought", async () => {
      await addBothChickenRecipes();
      const items = await itemsOf(HH_A);
      await grocery.setGroceryItemChecked(db!, DID_A, HH_A, { itemId: items[0].id, checked: true });

      const result = await grocery.clearAllItems(db!, DID_A, HH_A);
      expect(result.cleared).toBe(items.length);

      const after = await itemsOf(HH_A);
      expect(after).toHaveLength(items.length);
      expect(after.every((item) => item.cleared_at !== null)).toBe(true);
      // `checked_at` is untouched: sweeping a row you never ticked must not go
      // on the record as having bought it.
      expect(after.filter((item) => item.checked_at !== null)).toHaveLength(1);
      expect((await grocery.readGroceryList(db!, DID_A, HH_A)).items).toHaveLength(0);
    });

    it("a cleared row does not capture a re-add — the new one starts fresh", async () => {
      await grocery.addManualItem(db!, DID_A, HH_A, { text: "1 lb chicken breast" });
      const [first] = await itemsOf(HH_A);
      await grocery.clearAllItems(db!, DID_A, HH_A);

      await grocery.addManualItem(db!, DID_A, HH_A, { text: "1 lb chicken breast" });
      const list = await grocery.readGroceryList(db!, DID_A, HH_A);

      // Not a revival and not a re-total: a second row, holding only what was
      // just added. Clearing frees the identity the live index keys on.
      expect(list.items).toHaveLength(1);
      expect(list.items[0].id).not.toBe(first.id);
      expect(list.items[0].quantity).toBeCloseTo(453.59237, 2);
    });

    it("clearing twice does not re-clear what it already cleared", async () => {
      await addBothChickenRecipes();
      const items = await itemsOf(HH_A);

      expect((await grocery.clearAllItems(db!, DID_A, HH_A)).cleared).toBe(items.length);
      expect((await grocery.clearAllItems(db!, DID_A, HH_A)).cleared).toBe(0);
    });

    it("deletes the whole list — cleared rows included — and their sources with them", async () => {
      await addBothChickenRecipes();
      const items = await itemsOf(HH_A);
      expect(items.length).toBeGreaterThan(1);
      // One checked and swept, the rest still on the list: "delete everything"
      // is the only thing that reclaims a cleared row.
      await grocery.setGroceryItemChecked(db!, DID_A, HH_A, { itemId: items[0].id, checked: true });
      await grocery.clearPurchasedItems(db!, DID_A, HH_A);

      const result = await grocery.deleteAllItems(db!, DID_A, HH_A);
      expect(result.removed).toBe(items.length);
      expect(await itemsOf(HH_A)).toHaveLength(0);

      const sources = await db!
        .selectFrom("grocery_item_source")
        .select("id")
        .where(
          "item_id",
          "in",
          items.map((item) => item.id),
        )
        .execute();
      expect(sources).toHaveLength(0);
    });

    it("deleting everything on an empty list removes nothing", async () => {
      const result = await grocery.deleteAllItems(db!, DID_A, HH_A);
      expect(result.removed).toBe(0);
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

    it("committing refuses a hand-written source recipe the household has not boxed", async () => {
      // Preview is not the only door: a caller can post rows it wrote itself,
      // and `readGroceryList` joins `recipe` for the source title — so an
      // unchecked recipe id here would turn the list into a title lookup for
      // the whole corpus.
      const preview = await grocery.buildGroceryPreview(db!, DID_B, HH_B, { recipes: [{ recipeId: R_CHICKEN_LB }] });
      const forged = preview.rows.map((row) => ({ ...row, sources: row.sources.map((source) => ({ ...source, recipeId: R_CHICKEN_OZ })) }));

      await expect(grocery.commitGroceryRows(db!, DID_B, HH_B, { rows: forged })).rejects.toThrow(/not in this household/i);
      expect(await itemsOf(HH_B)).toHaveLength(0);
    });

    it("committing refuses a plan entry belonging to another household", async () => {
      const planEntryId = ulid();
      await db!
        .insertInto("meal_plan_entry")
        .values({ id: planEntryId, household_id: HH_A, plan_date: "2026-03-02", slot: "dinner", position: 0, kind: "recipe", recipe_id: R_CHICKEN_LB, created_by_did: DID_A })
        .execute();

      const preview = await grocery.buildGroceryPreview(db!, DID_B, HH_B, { recipes: [{ recipeId: R_CHICKEN_LB }] });
      const forged = preview.rows.map((row) => ({ ...row, sources: row.sources.map((source) => ({ ...source, planEntryId })) }));

      await expect(grocery.commitGroceryRows(db!, DID_B, HH_B, { rows: forged })).rejects.toThrow(/not in this household/i);
      await db!.deleteFrom("meal_plan_entry").where("id", "=", planEntryId).execute();
    });

    it("reading returns only the caller's household's list", async () => {
      await addBothChickenRecipes(HH_A, DID_A);
      const preview = await grocery.buildGroceryPreview(db!, DID_B, HH_B, { recipes: [{ recipeId: R_CHICKEN_LB }] });
      await grocery.commitGroceryRows(db!, DID_B, HH_B, { rows: preview.rows });

      const a = await grocery.readGroceryList(db!, DID_A, HH_A);
      const b = await grocery.readGroceryList(db!, DID_B, HH_B);

      const aChicken = a.items.find((item) => item.foodSlug === "en:chicken-breast")!;
      const bChicken = b.items.find((item) => item.foodSlug === "en:chicken-breast")!;
      // A has 1 lb + 8 oz; B has only 1 lb. Neither can see the other's total.
      expect(aChicken.quantity).toBeCloseTo(453.59237 + 8 * 28.349523, 2);
      expect(bChicken.quantity).toBeCloseTo(453.59237, 2);
    });

    it("a checked row is never visible to another household", async () => {
      // The TTL clause is a raw SQL fragment spliced into the WHERE, and `and`
      // binds tighter than `or`: unparenthesised, its second branch carries no
      // household predicate and hands every household's recently-checked rows
      // to everyone. Nothing else here checks a row off before reading, which
      // is exactly why that shipped unnoticed.
      await addBothChickenRecipes(HH_A, DID_A);
      const items = await itemsOf(HH_A);
      await grocery.setGroceryItemChecked(db!, DID_A, HH_A, { itemId: items[0].id, checked: true });

      const b = await grocery.readGroceryList(db!, DID_B, HH_B);
      expect(b.items).toHaveLength(0);
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

    it("clearing the purchased items never reaches another household", async () => {
      await addBothChickenRecipes(HH_A, DID_A);
      const items = await itemsOf(HH_A);
      await grocery.setGroceryItemChecked(db!, DID_A, HH_A, { itemId: items[0].id, checked: true });

      const result = await grocery.clearPurchasedItems(db!, DID_B, HH_B);
      expect(result.cleared).toBe(0);
      expect((await itemsOf(HH_A)).every((item) => item.cleared_at === null)).toBe(true);
    });

    it("clearing all never reaches another household", async () => {
      await addBothChickenRecipes(HH_A, DID_A);

      const result = await grocery.clearAllItems(db!, DID_B, HH_B);
      expect(result.cleared).toBe(0);
      expect((await itemsOf(HH_A)).every((item) => item.cleared_at === null)).toBe(true);
    });

    it("deleting everything never reaches another household", async () => {
      await addBothChickenRecipes(HH_A, DID_A);
      const items = await itemsOf(HH_A);

      const result = await grocery.deleteAllItems(db!, DID_B, HH_B);
      expect(result.removed).toBe(0);
      expect(await itemsOf(HH_A)).toHaveLength(items.length);
    });

    it("a manual item lands only on the caller's list", async () => {
      await grocery.addManualItem(db!, DID_A, HH_A, { text: "1 lb chicken breast" });
      expect(await itemsOf(HH_B)).toHaveLength(0);
    });
  });
});
