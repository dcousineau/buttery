import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "#/db/types";
import { type MealSlot, type PlanDate, shiftDays, todayIn, weekStartFor } from "#/lib/plan/week";
import { ulid } from "./household/ids";

/**
 * DB-backed integration tests for the meal planner (plan §13).
 *
 * These need a real Postgres with the migrations applied — the whole point is
 * the things a unit test cannot see: the CHECK constraints, the `ON DELETE
 * RESTRICT` FK, `FOR UPDATE` slot locking, dense `position` rewrites and the
 * household join that IS the authorization. Run them against the local dev
 * stack with:
 *
 *   pnpm test:db      # railway run --service buttery -- vitest run --project db
 *
 * With no reachable database the whole suite SKIPS with a message rather than
 * failing, so `pnpm test` stays green on a machine that has never booted the
 * stack. See `services/web/vitest.config.ts` for the project split.
 *
 * The server functions take their household from the session, so the tests
 * drive the exported, session-free bodies (`readMealPlanWeek`,
 * `addRecipesToPlan`, `movePlanEntry`, …) that every handler delegates to, and
 * assert against the table directly. Nothing here fakes a session; the session
 * → household resolution is the one line each handler still owns.
 *
 * Every test rebuilds its own scratch fixture (two households, a third with no
 * preference row, a member each, a handful of recipes) in `beforeEach` and the
 * suite deletes all of it in `afterAll`, so a run leaves the dev database
 * exactly as it found it and no test can depend on another.
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
  process.stderr.write(`\nSKIPPING meal-plan DB tests — ${reason}.\nRun them against the local dev stack with \`pnpm test:db\` (railway run injects DATABASE_URL).\n\n`);
}

/**
 * Resolve a usable Kysely handle, or null. Deliberately probes for the planner
 * table too: a database that is up but un-migrated would otherwise fail every
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
      sql`select 1 from meal_plan_entry limit 0`.execute(db),
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
/** Never gets a `household_preference` row unless a test writes one (§3.1). */
const HH_FRESH = `hh-fresh-${RUN}`;
const HOUSEHOLDS = [HH_A, HH_B, HH_FRESH];

const DID_A = `did:test:a-${RUN}`;
const DID_B = `did:test:b-${RUN}`;
const DIDS = [DID_A, DID_B];

const R1 = `rec-1-${RUN}`;
const R2 = `rec-2-${RUN}`;
const R3 = `rec-3-${RUN}`;
const R_UNBOXED = `rec-unboxed-${RUN}`;
const R_SYNC = `rec-sync-${RUN}`;
const RECIPES = [R1, R2, R3, R_UNBOXED, R_SYNC];

/** A Monday, so the fixture week matches the default `week_start_day = 1`. */
const MON: PlanDate = "2026-08-03";
const TUE: PlanDate = "2026-08-04";
const WED: PlanDate = "2026-08-05";
const NEXT_MON: PlanDate = "2026-08-10";
const NEXT_WED: PlanDate = "2026-08-12";

// Loaded lazily so a skipped run never imports the server modules at all.
type MealPlan = typeof import("./meal-plan");
type Preferences = typeof import("./household/preferences");
let plan: MealPlan;
let prefs: Preferences;

async function reset(): Promise<void> {
  if (!db) return;
  // Order matters: entries hold the RESTRICT FK onto `recipe`, so they go first.
  await db.deleteFrom("meal_plan_entry").where("household_id", "in", HOUSEHOLDS).execute();
  await db.deleteFrom("household_recipe").where("household_id", "in", HOUSEHOLDS).execute();
  await db.deleteFrom("household_preference").where("household_id", "in", HOUSEHOLDS).execute();
  await db.deleteFrom("recipe").where("id", "in", RECIPES).execute();

  await db
    .insertInto("recipe")
    .values([
      { id: R1, origin: "local", visibility: "public", name: "Shakshuka", total_time_seconds: 2700 },
      { id: R2, origin: "local", visibility: "public", name: "Dal Tadka", total_time_seconds: 5400 },
      { id: R3, origin: "local", visibility: "draft", name: "Sunday Sauce" },
      { id: R_UNBOXED, origin: "local", visibility: "public", name: "Not In The Box" },
      { id: R_SYNC, origin: "sync", visibility: "public", name: "Swept Recipe" },
    ])
    .execute();

  await db
    .insertInto("household_recipe")
    .values([
      { household_id: HH_A, recipe_id: R1, added_by_did: DID_A },
      { household_id: HH_A, recipe_id: R2, added_by_did: DID_A },
      { household_id: HH_A, recipe_id: R3, added_by_did: DID_A },
      { household_id: HH_A, recipe_id: R_SYNC, added_by_did: DID_A },
      { household_id: HH_B, recipe_id: R1, added_by_did: DID_B },
      { household_id: HH_FRESH, recipe_id: R1, added_by_did: DID_A },
    ])
    .execute();
}

// --- assertion helpers ---------------------------------------------------

interface SlotRow {
  id: string;
  kind: string;
  position: number;
  recipe_id: string | null;
  body: string | null;
  cooked_at: Date | null;
  cooked_by_did: string | null;
  created_by_did: string;
  plan_date: string;
}

/** Live rows of one slot, in canonical read order. */
async function liveSlot(householdId: string, date: PlanDate, slot: MealSlot): Promise<SlotRow[]> {
  if (!db) return [];
  const rows = await db
    .selectFrom("meal_plan_entry")
    .select(["id", "kind", "position", "recipe_id", "body", "cooked_at", "cooked_by_did", "created_by_did", sql<string>`to_char(plan_date, 'YYYY-MM-DD')`.as("plan_date")])
    .where("household_id", "=", householdId)
    .where("slot", "=", slot)
    .where("deleted_at", "is", null)
    .where(sql<boolean>`plan_date = ${date}::date`)
    .orderBy("position")
    .orderBy("created_at")
    .execute();
  return rows as SlotRow[];
}

/** One row by id, live or soft-deleted. */
async function rawEntry(id: string) {
  return db!
    .selectFrom("meal_plan_entry")
    .select(["id", "kind", "position", "recipe_id", "body", "cooked_at", "cooked_by_did", "deleted_at", "slot", sql<string>`to_char(plan_date, 'YYYY-MM-DD')`.as("plan_date")])
    .where("id", "=", id)
    .executeTakeFirst();
}

/** §3.6: `position` is dense `0..n-1` within a slot, always. */
function expectDense(rows: SlotRow[]): void {
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

/** Add one recipe and return its entry id. */
async function addRecipe(householdId: string, did: string, date: PlanDate, slot: MealSlot, recipeId: string): Promise<string> {
  const [created] = await plan.addRecipesToPlan(db!, did, householdId, { date, slot, recipeIds: [recipeId] });
  return created.id;
}

// --- suite ---------------------------------------------------------------

// The reason rides along in the suite name too, so a verbose reporter's
// "skipped" line says why without anyone hunting for the stderr note.
describe.skipIf(!db)(db ? "meal planner DB integration (§13)" : `meal planner DB integration (§13) — SKIPPED: ${skipReason}`, () => {
  beforeAll(async () => {
    plan = await import("./meal-plan");
    prefs = await import("./household/preferences");

    await db!
      .insertInto("household")
      .values([
        { id: HH_A, name: "Scratch A", created_by_did: DID_A },
        { id: HH_B, name: "Scratch B", created_by_did: DID_B },
        { id: HH_FRESH, name: "Scratch Fresh", created_by_did: DID_A },
      ])
      .execute();
    await db!
      .insertInto("household_member")
      .values([
        { household_id: HH_A, did: DID_A, role: "owner", invited_by_did: null },
        { household_id: HH_B, did: DID_B, role: "owner", invited_by_did: null },
        { household_id: HH_FRESH, did: DID_A, role: "owner", invited_by_did: null },
      ])
      .execute();
    // D17: the week read resolves DIDs to handles from `atproto_repo`.
    await db!
      .insertInto("atproto_repo")
      .values({ did: DID_A, handle: `a-${RUN}.test` })
      .execute();
  });

  beforeEach(reset);

  afterAll(async () => {
    if (!db) return;
    await db.deleteFrom("meal_plan_entry").where("household_id", "in", HOUSEHOLDS).execute();
    await db.deleteFrom("household_recipe").where("household_id", "in", HOUSEHOLDS).execute();
    await db.deleteFrom("household_preference").where("household_id", "in", HOUSEHOLDS).execute();
    await db.deleteFrom("household_member").where("household_id", "in", HOUSEHOLDS).execute();
    await db.deleteFrom("household").where("id", "in", HOUSEHOLDS).execute();
    await db.deleteFrom("recipe").where("id", "in", RECIPES).execute();
    await db.deleteFrom("atproto_repo").where("did", "in", DIDS).execute();
    // Belt and suspenders: nothing keyed on this run's DIDs may survive.
    await db.deleteFrom("household_member").where("did", "in", DIDS).execute();
    await db.destroy();
  });

  // --- §3.2 CHECK constraints -------------------------------------------

  describe("CHECK constraints reject malformed rows (§3.2)", () => {
    /** Bypasses every app-side validator on purpose — these are the DB's job. */
    function insertRaw(values: Record<string, unknown>) {
      return db!
        .insertInto("meal_plan_entry")
        .values({
          id: ulid(),
          household_id: HH_A,
          plan_date: MON,
          slot: "dinner",
          kind: "recipe",
          position: 0,
          created_by_did: DID_A,
          recipe_id: R1,
          ...values,
        } as never)
        .execute();
    }

    it("accepts a well-formed recipe row and a well-formed note row", async () => {
      await insertRaw({});
      await insertRaw({ kind: "note", recipe_id: null, body: "Leftovers", position: 1 });
      expect((await liveSlot(HH_A, MON, "dinner")).length).toBe(2);
    });

    it("rejects an unknown slot", async () => {
      const error = await expectRejects(() => insertRaw({ slot: "brunch" }));
      expect(error.code).toBe("23514");
      expect(error.constraint).toBe("meal_plan_entry_slot_check");
    });

    it("rejects an unknown kind", async () => {
      const error = await expectRejects(() => insertRaw({ kind: "collection" }));
      expect(error.code).toBe("23514");
      expect(error.constraint).toBe("meal_plan_entry_kind_check");
    });

    it("rejects kind='recipe' carrying a body", async () => {
      const error = await expectRejects(() => insertRaw({ body: "not allowed here" }));
      expect(error.code).toBe("23514");
      expect(error.constraint).toBe("meal_plan_entry_recipe_shape_check");
    });

    it("rejects kind='recipe' with no recipe_id", async () => {
      const error = await expectRejects(() => insertRaw({ recipe_id: null }));
      expect(error.constraint).toBe("meal_plan_entry_recipe_shape_check");
    });

    it("rejects kind='note' carrying a recipe_id", async () => {
      const error = await expectRejects(() => insertRaw({ kind: "note", body: "Leftovers" }));
      expect(error.code).toBe("23514");
      expect(error.constraint).toBe("meal_plan_entry_note_shape_check");
    });

    it("rejects kind='note' with no body", async () => {
      const error = await expectRejects(() => insertRaw({ kind: "note", recipe_id: null }));
      expect(error.constraint).toBe("meal_plan_entry_note_shape_check");
    });

    it("rejects an out-of-range week_start_day on household_preference (§3.1)", async () => {
      const error = await expectRejects(() => db!.insertInto("household_preference").values({ household_id: HH_A, week_start_day: 8, timezone: "UTC" }).execute());
      expect(error.code).toBe("23514");
      expect(error.constraint).toBe("household_preference_week_start_day_check");
    });
  });

  // --- §6.1 the week read -------------------------------------------------

  describe("readMealPlanWeek (§6.1)", () => {
    it("returns all 7 days and all 4 slots with defaults for a household that has no preference row (acceptance 2, 4)", async () => {
      const week = await plan.readMealPlanWeek(db!, DID_A, HH_FRESH, WED);
      expect(week.weekStartDay).toBe(1);
      expect(week.timezone).toBe("UTC");
      // A mid-week hint is re-snapped to the household's week start, never obeyed.
      expect(week.weekStart).toBe(MON);
      expect(week.weekEnd).toBe("2026-08-09");
      expect(week.days.map((day) => day.date)).toEqual(["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09"]);
      for (const day of week.days) expect(Object.keys(day.slots).sort()).toEqual(["breakfast", "dinner", "lunch", "snack"]);
      expect(week.recipeEntryCount).toBe(0);
      expect(week.cookedCount).toBe(0);
      expect(week.emptySlotCount).toBe(28);
      // No row was materialised by reading (§3.1).
      const row = await db!.selectFrom("household_preference").select("household_id").where("household_id", "=", HH_FRESH).executeTakeFirst();
      expect(row).toBeUndefined();
    });

    it("re-snaps the week against a non-default week_start_day", async () => {
      await prefs.writeHouseholdPreferences(HH_A, { weekStartDay: 7, timezone: "UTC" });
      const week = await plan.readMealPlanWeek(db!, DID_A, HH_A, WED);
      // Sunday-start: the week containing Wed 2026-08-05 begins Sun 2026-08-02.
      expect(week.weekStart).toBe("2026-08-02");
      expect(week.weekStartDay).toBe(7);
    });

    it("buckets entries by day and slot in position order, and counts the panel stats", async () => {
      await plan.addRecipesToPlan(db!, DID_A, HH_A, { date: MON, slot: "dinner", recipeIds: [R1, R2] });
      await plan.addNoteToPlan(db!, DID_A, HH_A, { date: MON, slot: "dinner", body: "Sam cooks" });
      await addRecipe(HH_A, DID_A, WED, "breakfast", R2);

      const week = await plan.readMealPlanWeek(db!, DID_A, HH_A, MON);
      const dinner = week.days[0].slots.dinner;
      expect(dinner.map((entry) => entry.position)).toEqual([0, 1, 2]);
      expect(dinner.map((entry) => entry.kind)).toEqual(["recipe", "recipe", "note"]);
      expect(dinner[0]).toMatchObject({ kind: "recipe", recipeId: R1, title: "Shakshuka", inBox: true, totalTimeDisplay: "45m" });
      expect(dinner[2]).toMatchObject({ kind: "note", body: "Sam cooks" });
      expect(dinner[0].addedByHandle).toBe(`@a-${RUN}.test`);
      expect(week.days[2].slots.breakfast.map((entry) => entry.position)).toEqual([0]);
      expect(week.recipeEntryCount).toBe(3);
      expect(week.emptySlotCount).toBe(26);
    });

    it("reports inBox=false for a planned recipe that left the box (D3/§7.2)", async () => {
      await addRecipe(HH_A, DID_A, MON, "dinner", R1);
      await db!.deleteFrom("household_recipe").where("household_id", "=", HH_A).where("recipe_id", "=", R1).execute();

      const week = await plan.readMealPlanWeek(db!, DID_A, HH_A, MON);
      const entry = week.days[0].slots.dinner[0];
      expect(entry).toMatchObject({ kind: "recipe", recipeId: R1, title: "Shakshuka", inBox: false });
    });
  });

  // --- §6.10 household scoping -------------------------------------------

  describe("household scoping — the membership join is the authorization (§6.10, acceptance 14)", () => {
    let foreignEntry: string;

    beforeEach(async () => {
      foreignEntry = await addRecipe(HH_B, DID_B, MON, "dinner", R1);
    });

    it("a member of A never sees B's entries", async () => {
      await addRecipe(HH_A, DID_A, MON, "lunch", R1);
      const week = await plan.readMealPlanWeek(db!, DID_A, HH_A, MON);
      expect(week.days[0].slots.dinner).toEqual([]);
      expect(week.recipeEntryCount).toBe(1);
    });

    it("a non-member reading B's household reads nothing at all", async () => {
      // Same query, same household id, different DID: the scoped join yields no
      // membership row, so there is nothing to inner-join the entries onto.
      const asOutsider = await plan.readMealPlanWeek(db!, DID_A, HH_B, MON);
      expect(asOutsider.recipeEntryCount).toBe(0);
      expect(asOutsider.emptySlotCount).toBe(28);
      const asMember = await plan.readMealPlanWeek(db!, DID_B, HH_B, MON);
      expect(asMember.recipeEntryCount).toBe(1);
    });

    it("moving B's entry from household A is rejected and changes nothing", async () => {
      await expect(plan.movePlanEntry(db!, HH_A, { entryId: foreignEntry, toDate: TUE, toSlot: "lunch" })).rejects.toThrow(/no longer on the plan/);
      const row = await rawEntry(foreignEntry);
      expect(row).toMatchObject({ plan_date: MON, slot: "dinner", position: 0, deleted_at: null });
    });

    it("removing B's entry from household A is a no-op, not a delete", async () => {
      expect(await plan.removePlanEntry(db!, HH_A, { entryId: foreignEntry })).toEqual({ removed: false });
      expect((await rawEntry(foreignEntry))?.deleted_at).toBeNull();
    });

    it("marking B's entry cooked from household A is rejected", async () => {
      await expect(plan.setPlanEntryCooked(db!, DID_A, HH_A, { entryId: foreignEntry, cooked: true })).rejects.toThrow(/can't be marked cooked/);
      expect((await rawEntry(foreignEntry))?.cooked_at).toBeNull();
    });

    it("editing B's note from household A is rejected", async () => {
      const note = await plan.addNoteToPlan(db!, DID_B, HH_B, { date: MON, slot: "lunch", body: "B's note" });
      await expect(plan.updatePlanNote(db!, HH_A, { entryId: note.id, body: "hijacked" })).rejects.toThrow(/no longer on the plan/);
      expect((await rawEntry(note.id))?.body).toBe("B's note");
    });

    it("planned usage never counts another household's entries", async () => {
      expect(await plan.readPlannedUsage(db!, HH_A, R1)).toMatchObject({ total: 0, upcoming: 0, nextDate: null });
      expect((await plan.readPlannedUsage(db!, HH_B, R1)).total).toBe(1);
    });

    it("a recipe that is not in the caller's box cannot be planned (§6.2)", async () => {
      await expect(plan.addRecipesToPlan(db!, DID_A, HH_A, { date: MON, slot: "dinner", recipeIds: [R_UNBOXED] })).rejects.toThrow(/not in this household's box/);
      expect(await liveSlot(HH_A, MON, "dinner")).toEqual([]);
      // One bad id fails the whole call — no half-success.
      await expect(plan.addRecipesToPlan(db!, DID_A, HH_A, { date: MON, slot: "dinner", recipeIds: [R1, R_UNBOXED] })).rejects.toThrow();
      expect(await liveSlot(HH_A, MON, "dinner")).toEqual([]);
    });
  });

  // --- §6.2/§6.3 add ------------------------------------------------------

  describe("adding entries (§6.2, §6.3, acceptance 5)", () => {
    it("appends three recipes in the order given, densely numbered", async () => {
      const created = await plan.addRecipesToPlan(db!, DID_A, HH_A, { date: MON, slot: "dinner", recipeIds: [R3, R1, R2] });
      expect(created.map((entry) => entry.position)).toEqual([0, 1, 2]);
      const rows = await liveSlot(HH_A, MON, "dinner");
      expect(rows.map((row) => row.recipe_id)).toEqual([R3, R1, R2]);
      expect(rows.every((row) => row.created_by_did === DID_A)).toBe(true);
      expectDense(rows);
    });

    it("accepts the same recipe twice in one slot (D4)", async () => {
      await plan.addRecipesToPlan(db!, DID_A, HH_A, { date: MON, slot: "dinner", recipeIds: [R1, R1] });
      const rows = await liveSlot(HH_A, MON, "dinner");
      expect(rows.map((row) => row.recipe_id)).toEqual([R1, R1]);
      expect(new Set(rows.map((row) => row.id)).size).toBe(2);
      expectDense(rows);
    });

    it("a second add appends to the tail rather than restarting at 0 (D14)", async () => {
      await addRecipe(HH_A, DID_A, MON, "dinner", R1);
      await plan.addNoteToPlan(db!, DID_A, HH_A, { date: MON, slot: "dinner", body: "then dessert" });
      const created = await plan.addRecipesToPlan(db!, DID_A, HH_A, { date: MON, slot: "dinner", recipeIds: [R2] });
      expect(created[0].position).toBe(2);
      expectDense(await liveSlot(HH_A, MON, "dinner"));
    });

    it("stores a note, edits it in place, and removes it when the body is emptied (§6.3, acceptance 6)", async () => {
      const note = await plan.addNoteToPlan(db!, DID_A, HH_A, { date: MON, slot: "lunch", body: "Leftovers" });
      expect(await plan.updatePlanNote(db!, HH_A, { entryId: note.id, body: "Leftovers, again" })).toEqual({ removed: false });
      expect((await rawEntry(note.id))?.body).toBe("Leftovers, again");

      expect(await plan.updatePlanNote(db!, HH_A, { entryId: note.id, body: "" })).toEqual({ removed: true });
      const row = await rawEntry(note.id);
      expect(row?.deleted_at).not.toBeNull();
      // Soft delete, not a rewrite: the last body survives on the dead row.
      expect(row?.body).toBe("Leftovers, again");
      expect(await liveSlot(HH_A, MON, "lunch")).toEqual([]);
    });

    it("refuses to edit a recipe entry as if it were a note", async () => {
      const entry = await addRecipe(HH_A, DID_A, MON, "dinner", R1);
      await expect(plan.updatePlanNote(db!, HH_A, { entryId: entry, body: "stuffed into a recipe row" })).rejects.toThrow(/no longer on the plan/);
      expect((await rawEntry(entry))?.body).toBeNull();
    });
  });

  // --- §6.4 move ----------------------------------------------------------

  describe("moveMealPlanEntry (§6.4, §3.6, acceptance 7)", () => {
    let a: string;
    let b: string;
    let c: string;

    beforeEach(async () => {
      const created = await plan.addRecipesToPlan(db!, DID_A, HH_A, { date: MON, slot: "dinner", recipeIds: [R1, R2, R3] });
      [a, b, c] = created.map((entry) => entry.id);
    });

    it("appends to the destination tail and leaves BOTH slots dense", async () => {
      await addRecipe(HH_A, DID_A, TUE, "lunch", R1);
      expect(await plan.movePlanEntry(db!, HH_A, { entryId: b, toDate: TUE, toSlot: "lunch" })).toEqual({ moved: true });

      const source = await liveSlot(HH_A, MON, "dinner");
      expect(source.map((row) => row.id)).toEqual([a, c]);
      expectDense(source);

      const dest = await liveSlot(HH_A, TUE, "lunch");
      expect(dest.map((row) => row.id)[1]).toBe(b);
      expect(dest[1].position).toBe(1);
      expectDense(dest);
      expect(dest[1].plan_date).toBe(TUE);
    });

    it("moves across days within the same slot name", async () => {
      await plan.movePlanEntry(db!, HH_A, { entryId: a, toDate: WED, toSlot: "dinner" });
      expect((await liveSlot(HH_A, MON, "dinner")).map((row) => row.id)).toEqual([b, c]);
      expect((await liveSlot(HH_A, WED, "dinner")).map((row) => row.id)).toEqual([a]);
      expectDense(await liveSlot(HH_A, MON, "dinner"));
    });

    it("a move to the entry's current (date, slot) is a no-op", async () => {
      const before = await liveSlot(HH_A, MON, "dinner");
      expect(await plan.movePlanEntry(db!, HH_A, { entryId: b, toDate: MON, toSlot: "dinner" })).toEqual({ moved: false });
      expect(await liveSlot(HH_A, MON, "dinner")).toEqual(before);
    });

    it("moves into an empty slot on a past date (D6)", async () => {
      await plan.movePlanEntry(db!, HH_A, { entryId: c, toDate: "2020-01-01", toSlot: "snack" });
      const dest = await liveSlot(HH_A, "2020-01-01", "snack");
      expect(dest.map((row) => row.id)).toEqual([c]);
      expect(dest[0].position).toBe(0);
    });

    it("rejects a move of an already-removed entry", async () => {
      await plan.removePlanEntry(db!, HH_A, { entryId: b });
      await expect(plan.movePlanEntry(db!, HH_A, { entryId: b, toDate: TUE, toSlot: "lunch" })).rejects.toThrow(/no longer on the plan/);
    });

    it("survives a burst of concurrent moves into one slot with dense positions (§3.6 locking)", async () => {
      // The `FOR UPDATE` slot locks are what make this deterministic: without
      // them the three writers would each read the same tail length.
      const extra = await plan.addRecipesToPlan(db!, DID_A, HH_A, { date: MON, slot: "breakfast", recipeIds: [R1, R2, R3] });
      await addRecipe(HH_A, DID_A, TUE, "snack", R1);
      await Promise.all(extra.map((entry) => plan.movePlanEntry(db!, HH_A, { entryId: entry.id, toDate: TUE, toSlot: "snack" })));

      const dest = await liveSlot(HH_A, TUE, "snack");
      expect(dest.length).toBe(4);
      expectDense(dest);
      expect(new Set(dest.map((row) => row.position)).size).toBe(4);
      expect(await liveSlot(HH_A, MON, "breakfast")).toEqual([]);
    });
  });

  // --- §6.5 soft delete ---------------------------------------------------

  describe("removeMealPlanEntry — soft delete (§3.5, §6.5, acceptance 8)", () => {
    it("hides the entry everywhere while the row survives with deleted_at and its recipe FK", async () => {
      const [a, b, c] = (await plan.addRecipesToPlan(db!, DID_A, HH_A, { date: MON, slot: "dinner", recipeIds: [R1, R2, R3] })).map((entry) => entry.id);

      expect(await plan.removePlanEntry(db!, HH_A, { entryId: b })).toEqual({ removed: true });

      const row = await rawEntry(b);
      expect(row?.deleted_at).not.toBeNull();
      // The FK reference is retained on purpose — a restored plan must not have
      // lost its recipe, and the cron sweep guard depends on seeing it (§7.3).
      expect(row?.recipe_id).toBe(R2);

      const rows = await liveSlot(HH_A, MON, "dinner");
      expect(rows.map((entry) => entry.id)).toEqual([a, c]);
      expectDense(rows);

      const week = await plan.readMealPlanWeek(db!, DID_A, HH_A, MON);
      expect(week.days[0].slots.dinner.map((entry) => entry.id)).toEqual([a, c]);
      expect(week.recipeEntryCount).toBe(2);
    });

    it("is idempotent (D10)", async () => {
      const entry = await addRecipe(HH_A, DID_A, MON, "dinner", R1);
      expect(await plan.removePlanEntry(db!, HH_A, { entryId: entry })).toEqual({ removed: true });
      expect(await plan.removePlanEntry(db!, HH_A, { entryId: entry })).toEqual({ removed: false });
      expect(await plan.removePlanEntry(db!, HH_A, { entryId: `nope-${RUN}` })).toEqual({ removed: false });
    });

    it("keeps positions dense when the tail entry goes", async () => {
      const created = await plan.addRecipesToPlan(db!, DID_A, HH_A, { date: MON, slot: "dinner", recipeIds: [R1, R2, R3] });
      await plan.removePlanEntry(db!, HH_A, { entryId: created[2].id });
      expectDense(await liveSlot(HH_A, MON, "dinner"));
      await plan.removePlanEntry(db!, HH_A, { entryId: created[0].id });
      const rows = await liveSlot(HH_A, MON, "dinner");
      expect(rows.map((row) => row.id)).toEqual([created[1].id]);
      expectDense(rows);
    });

    it("a soft-deleted entry is invisible to planned usage (§6.8)", async () => {
      const entry = await addRecipe(HH_A, DID_A, MON, "dinner", R1);
      expect((await plan.readPlannedUsage(db!, HH_A, R1)).total).toBe(1);
      await plan.removePlanEntry(db!, HH_A, { entryId: entry });
      expect(await plan.readPlannedUsage(db!, HH_A, R1)).toEqual({ total: 0, upcoming: 0, nextDate: null });
    });
  });

  // --- §3.4/§7.3 the RESTRICT FK and the sweep guard ----------------------

  describe("ON DELETE RESTRICT and the cron sweep guard (§3.4, §7.3, acceptance 12)", () => {
    // Copied verbatim from `services/atproto-cron-sync/src/render.ts:340`
    // (`PLANNED_GUARD`). If that string ever changes, this test is the alarm.
    const PLANNED_GUARD = `not exists (select 1 from meal_plan_entry mpe where mpe.recipe_id = recipe.id)`;
    const BOX_GUARD = `not exists (select 1 from household_recipe hr where hr.recipe_id = recipe.id)`;

    /** The sweep's delete, with §7.3's guard. */
    function guardedSweep(recipeId: string) {
      return sql<{ id: string }>`delete from recipe where id = ${recipeId} and origin = 'sync' and ${sql.raw(BOX_GUARD)} and ${sql.raw(PLANNED_GUARD)} returning id`.execute(db!);
    }

    /** The pre-§7.3 sweep — kept only to prove the guard is load-bearing. */
    function unguardedSweep(recipeId: string) {
      return sql`delete from recipe where id = ${recipeId} and origin = 'sync' and ${sql.raw(BOX_GUARD)}`.execute(db!);
    }

    async function unboxSweptRecipe() {
      await db!.deleteFrom("household_recipe").where("recipe_id", "=", R_SYNC).execute();
    }

    /**
     * `ON DELETE RESTRICT` raises `restrict_violation` (23001). The 23503
     * `foreign_key_violation` named in §13 is what a `NO ACTION` FK raises —
     * the difference is which code Postgres picks, not whether the delete is
     * refused, so both are accepted and the constraint name carries the real
     * assertion.
     */
    function expectFkRefusal(error: PgError): void {
      expect(["23001", "23503"]).toContain(error.code);
      expect(error.constraint).toBe("meal_plan_entry_recipe_id_fkey");
    }

    it("refuses the delete when a LIVE plan entry references the recipe", async () => {
      await addRecipe(HH_A, DID_A, MON, "dinner", R_SYNC);
      await unboxSweptRecipe();
      expectFkRefusal(await expectRejects(() => unguardedSweep(R_SYNC)));
      expect(await db!.selectFrom("recipe").select("id").where("id", "=", R_SYNC).executeTakeFirst()).toBeDefined();
    });

    it("refuses the delete when only a SOFT-DELETED plan entry references the recipe", async () => {
      const entry = await addRecipe(HH_A, DID_A, MON, "dinner", R_SYNC);
      await plan.removePlanEntry(db!, HH_A, { entryId: entry });
      await unboxSweptRecipe();
      expectFkRefusal(await expectRejects(() => unguardedSweep(R_SYNC)));
      expect(await db!.selectFrom("recipe").select("id").where("id", "=", R_SYNC).executeTakeFirst()).toBeDefined();
    });

    it("the guard's predicate protects both cases, so the sweep never attempts the delete", async () => {
      const entry = await addRecipe(HH_A, DID_A, MON, "dinner", R_SYNC);
      await unboxSweptRecipe();

      // Live entry: guarded delete matches nothing and does NOT raise.
      expect((await guardedSweep(R_SYNC)).rows).toEqual([]);

      // Soft-deleted entry: the guard is deliberately NOT filtered on
      // `deleted_at`, so it still sees the row and still protects the recipe.
      await plan.removePlanEntry(db!, HH_A, { entryId: entry });
      expect((await guardedSweep(R_SYNC)).rows).toEqual([]);

      // Once nothing references it at all, the same statement sweeps it.
      await db!.deleteFrom("meal_plan_entry").where("recipe_id", "=", R_SYNC).execute();
      expect((await guardedSweep(R_SYNC)).rows.map((row) => row.id)).toEqual([R_SYNC]);
    });

    it("removing a recipe from the box never touches the plan entry (D3)", async () => {
      const entry = await addRecipe(HH_A, DID_A, MON, "dinner", R1);
      await db!.deleteFrom("household_recipe").where("household_id", "=", HH_A).where("recipe_id", "=", R1).execute();
      expect((await rawEntry(entry))?.deleted_at).toBeNull();
      expect((await rawEntry(entry))?.recipe_id).toBe(R1);
    });
  });

  // --- §6.6 cooked marks --------------------------------------------------

  describe("setMealPlanEntryCooked (§6.6, acceptance 9)", () => {
    it("sets and clears the mark, recording who did it", async () => {
      const entry = await addRecipe(HH_A, DID_A, MON, "dinner", R1);

      const marked = await plan.setPlanEntryCooked(db!, DID_A, HH_A, { entryId: entry, cooked: true });
      expect(marked.cookedAt).toEqual(expect.any(String));
      let row = await rawEntry(entry);
      expect(row?.cooked_at).not.toBeNull();
      expect(row?.cooked_by_did).toBe(DID_A);

      const cleared = await plan.setPlanEntryCooked(db!, DID_A, HH_A, { entryId: entry, cooked: false });
      expect(cleared.cookedAt).toBeNull();
      row = await rawEntry(entry);
      expect(row?.cooked_at).toBeNull();
      expect(row?.cooked_by_did).toBeNull();
    });

    it("surfaces the mark and the cook's handle in the week read (D17)", async () => {
      const entry = await addRecipe(HH_A, DID_A, MON, "dinner", R1);
      await plan.setPlanEntryCooked(db!, DID_A, HH_A, { entryId: entry, cooked: true });

      const week = await plan.readMealPlanWeek(db!, DID_A, HH_A, MON);
      const read = week.days[0].slots.dinner[0];
      expect(read.kind).toBe("recipe");
      expect(read.cookedAt).toEqual(expect.any(String));
      expect(read.kind === "recipe" && read.cookedByHandle).toBe(`@a-${RUN}.test`);
      expect(week.cookedCount).toBe(1);
    });

    it("a note entry rejects a cooked mark and stays untouched", async () => {
      const note = await plan.addNoteToPlan(db!, DID_A, HH_A, { date: MON, slot: "dinner", body: "Leftovers" });
      await expect(plan.setPlanEntryCooked(db!, DID_A, HH_A, { entryId: note.id, cooked: true })).rejects.toThrow(/can't be marked cooked/);
      const row = await rawEntry(note.id);
      expect(row?.cooked_at).toBeNull();
      expect(row?.cooked_by_did).toBeNull();
    });

    it("a removed entry rejects a cooked mark", async () => {
      const entry = await addRecipe(HH_A, DID_A, MON, "dinner", R1);
      await plan.removePlanEntry(db!, HH_A, { entryId: entry });
      await expect(plan.setPlanEntryCooked(db!, DID_A, HH_A, { entryId: entry, cooked: true })).rejects.toThrow(/can't be marked cooked/);
    });

    it("permits marking a future-dated entry (§6.6)", async () => {
      const entry = await addRecipe(HH_A, DID_A, "2099-12-31", "dinner", R1);
      expect((await plan.setPlanEntryCooked(db!, DID_A, HH_A, { entryId: entry, cooked: true })).cookedAt).toEqual(expect.any(String));
    });
  });

  // --- §6.7 copy week -----------------------------------------------------

  describe("copyMealPlanWeek (§6.7, acceptance 10)", () => {
    async function seedSourceWeek() {
      const [monDinner] = await plan.addRecipesToPlan(db!, DID_A, HH_A, { date: MON, slot: "dinner", recipeIds: [R1, R2] });
      await plan.addNoteToPlan(db!, DID_A, HH_A, { date: MON, slot: "dinner", body: "double batch" });
      await addRecipe(HH_A, DID_A, WED, "breakfast", R3);
      await plan.setPlanEntryCooked(db!, DID_A, HH_A, { entryId: monDinner.id, cooked: true });
      return monDinner.id;
    }

    it("maps every entry onto the same weekday, keeps notes, and clears cooked marks", async () => {
      await seedSourceWeek();
      const result = await plan.copyPlanWeek(db!, DID_B, HH_A, { fromWeek: MON, toWeek: NEXT_MON, mode: "append" });
      expect(result).toMatchObject({ copied: 4, fromWeek: MON, toWeek: NEXT_MON, toWeekEnd: "2026-08-16" });

      const dinner = await liveSlot(HH_A, NEXT_MON, "dinner");
      expect(dinner.map((row) => row.kind)).toEqual(["recipe", "recipe", "note"]);
      expect(dinner.map((row) => row.recipe_id)).toEqual([R1, R2, null]);
      expect(dinner[2].body).toBe("double batch");
      expect(dinner.every((row) => row.cooked_at === null && row.cooked_by_did === null)).toBe(true);
      // New rows, authored by whoever ran the copy.
      expect(dinner.every((row) => row.created_by_did === DID_B)).toBe(true);
      expectDense(dinner);

      // Wednesday's breakfast lands on the destination week's Wednesday.
      const breakfast = await liveSlot(HH_A, NEXT_WED, "breakfast");
      expect(breakfast.map((row) => row.recipe_id)).toEqual([R3]);

      // The source week is untouched, cooked mark included.
      const source = await liveSlot(HH_A, MON, "dinner");
      expect(source.length).toBe(3);
      expect(source[0].cooked_at).not.toBeNull();
    });

    it("re-snaps mid-week arguments to week starts", async () => {
      await seedSourceWeek();
      const result = await plan.copyPlanWeek(db!, DID_A, HH_A, { fromWeek: WED, toWeek: NEXT_WED, mode: "append" });
      expect(result.fromWeek).toBe(MON);
      expect(result.toWeek).toBe(NEXT_MON);
      // Wednesday → Wednesday, not Wednesday → wherever the raw offset landed.
      expect((await liveSlot(HH_A, NEXT_WED, "breakfast")).length).toBe(1);
    });

    it("append lands after what the destination already holds, densely", async () => {
      await seedSourceWeek();
      const existing = await addRecipe(HH_A, DID_A, NEXT_MON, "dinner", R2);

      await plan.copyPlanWeek(db!, DID_A, HH_A, { fromWeek: MON, toWeek: NEXT_MON, mode: "append" });

      const dinner = await liveSlot(HH_A, NEXT_MON, "dinner");
      expect(dinner.map((row) => row.id)[0]).toBe(existing);
      expect(dinner.length).toBe(4);
      expectDense(dinner);
    });

    it("replace soft-deletes the destination week first", async () => {
      await seedSourceWeek();
      const doomed = await addRecipe(HH_A, DID_A, NEXT_MON, "dinner", R2);
      const doomedElsewhere = await addRecipe(HH_A, DID_A, "2026-08-14", "lunch", R1);
      // A neighbouring week must survive: the wipe is week-scoped.
      const survivor = await addRecipe(HH_A, DID_A, "2026-08-17", "lunch", R1);

      const result = await plan.copyPlanWeek(db!, DID_A, HH_A, { fromWeek: MON, toWeek: NEXT_MON, mode: "replace" });
      expect(result.copied).toBe(4);

      expect((await rawEntry(doomed))?.deleted_at).not.toBeNull();
      expect((await rawEntry(doomedElsewhere))?.deleted_at).not.toBeNull();
      expect((await rawEntry(survivor))?.deleted_at).toBeNull();

      const dinner = await liveSlot(HH_A, NEXT_MON, "dinner");
      expect(dinner.length).toBe(3);
      expectDense(dinner);
      expect(await liveSlot(HH_A, "2026-08-14", "lunch")).toEqual([]);
    });

    it("copying an empty week copies nothing and leaves the destination alone", async () => {
      const untouched = await addRecipe(HH_A, DID_A, NEXT_MON, "dinner", R1);

      expect(await plan.copyPlanWeek(db!, DID_A, HH_A, { fromWeek: MON, toWeek: NEXT_MON, mode: "append" })).toMatchObject({ copied: 0 });
      // Documented behaviour: an empty source returns before the `replace`
      // wipe, so "replace with nothing" cannot silently erase a week.
      expect(await plan.copyPlanWeek(db!, DID_A, HH_A, { fromWeek: MON, toWeek: NEXT_MON, mode: "replace" })).toMatchObject({ copied: 0 });
      expect((await rawEntry(untouched))?.deleted_at).toBeNull();
      expect((await liveSlot(HH_A, NEXT_MON, "dinner")).length).toBe(1);
    });

    it("copying a week onto itself in replace mode rebuilds it instead of erasing it", async () => {
      const original = await seedSourceWeek();
      const result = await plan.copyPlanWeek(db!, DID_A, HH_A, { fromWeek: MON, toWeek: MON, mode: "replace" });
      expect(result.copied).toBe(4);

      expect((await rawEntry(original))?.deleted_at).not.toBeNull();
      const dinner = await liveSlot(HH_A, MON, "dinner");
      expect(dinner.length).toBe(3);
      expect(dinner.map((row) => row.id)).not.toContain(original);
      // The rebuild is a fresh plan: nothing is cooked yet.
      expect(dinner.every((row) => row.cooked_at === null)).toBe(true);
      expectDense(dinner);
    });

    it("respects a non-default week_start_day when snapping both weeks", async () => {
      await prefs.writeHouseholdPreferences(HH_A, { weekStartDay: 7, timezone: "UTC" });
      await addRecipe(HH_A, DID_A, MON, "dinner", R1);
      const result = await plan.copyPlanWeek(db!, DID_A, HH_A, { fromWeek: MON, toWeek: NEXT_MON, mode: "append" });
      expect(result.fromWeek).toBe("2026-08-02");
      expect(result.toWeek).toBe("2026-08-09");
      // Monday → Monday, one week on.
      expect((await liveSlot(HH_A, NEXT_MON, "dinner")).length).toBe(1);
    });

    it("does not reach into another household's week", async () => {
      await addRecipe(HH_B, DID_B, MON, "dinner", R1);
      expect(await plan.copyPlanWeek(db!, DID_A, HH_A, { fromWeek: MON, toWeek: NEXT_MON, mode: "append" })).toMatchObject({ copied: 0 });
      expect((await liveSlot(HH_B, NEXT_MON, "dinner")).length).toBe(0);
    });
  });

  // --- §6.8 planned usage -------------------------------------------------

  describe("readPlannedUsage (§6.8)", () => {
    it("counts live entries and measures 'upcoming' from today in UTC", async () => {
      const today = todayIn("UTC");
      await addRecipe(HH_A, DID_A, shiftDays(today, -3), "dinner", R1);
      await addRecipe(HH_A, DID_A, today, "lunch", R1);
      const future = await addRecipe(HH_A, DID_A, shiftDays(today, 5), "dinner", R1);

      expect(await plan.readPlannedUsage(db!, HH_A, R1)).toEqual({ total: 3, upcoming: 2, nextDate: today });

      await plan.removePlanEntry(db!, HH_A, { entryId: future });
      expect(await plan.readPlannedUsage(db!, HH_A, R1)).toEqual({ total: 2, upcoming: 1, nextDate: today });
    });

    it("measures 'upcoming' against the household timezone, not the server's", async () => {
      // These two zones are 26 hours apart, so their calendar dates ALWAYS
      // differ — no wall-clock luck required for this assertion.
      const ahead = "Pacific/Kiritimati"; // UTC+14
      const behind = "Etc/GMT+12"; // UTC-12
      const dateBehind = todayIn(behind);
      const dateAhead = todayIn(ahead);
      expect(dateBehind < dateAhead).toBe(true);

      await addRecipe(HH_A, DID_A, dateBehind, "dinner", R1);

      await prefs.writeHouseholdPreferences(HH_A, { weekStartDay: 1, timezone: behind });
      expect(await plan.readPlannedUsage(db!, HH_A, R1)).toEqual({ total: 1, upcoming: 1, nextDate: dateBehind });

      // Same row, same instant, a household living a day ahead: already past.
      await prefs.writeHouseholdPreferences(HH_A, { weekStartDay: 1, timezone: ahead });
      expect(await plan.readPlannedUsage(db!, HH_A, R1)).toEqual({ total: 1, upcoming: 0, nextDate: null });
    });

    it("counts each duplicate in a slot separately (D4)", async () => {
      const today = todayIn("UTC");
      await plan.addRecipesToPlan(db!, DID_A, HH_A, { date: today, slot: "dinner", recipeIds: [R1, R1] });
      expect(await plan.readPlannedUsage(db!, HH_A, R1)).toMatchObject({ total: 2, upcoming: 2 });
    });
  });

  // --- §3.1 preference materialisation ------------------------------------

  describe("household_preference lazy materialisation (§3.1, §6.11, acceptance 20)", () => {
    it("reads defaults with no row, and writes one only on the first save", async () => {
      expect(await prefs.readHouseholdPreferences(HH_FRESH)).toEqual({ weekStartDay: 1, timezone: "UTC" });
      expect(await db!.selectFrom("household_preference").select("household_id").where("household_id", "=", HH_FRESH).executeTakeFirst()).toBeUndefined();

      await prefs.writeHouseholdPreferences(HH_FRESH, { weekStartDay: 7, timezone: "America/Chicago" });

      const rows = await db!.selectFrom("household_preference").selectAll().where("household_id", "=", HH_FRESH).execute();
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ week_start_day: 7, timezone: "America/Chicago" });
      expect(await prefs.readHouseholdPreferences(HH_FRESH)).toEqual({ weekStartDay: 7, timezone: "America/Chicago" });
    });

    it("upserts in place on the second save and bumps updated_at", async () => {
      await prefs.writeHouseholdPreferences(HH_FRESH, { weekStartDay: 7, timezone: "America/Chicago" });
      const first = await db!.selectFrom("household_preference").selectAll().where("household_id", "=", HH_FRESH).executeTakeFirstOrThrow();

      await prefs.writeHouseholdPreferences(HH_FRESH, { weekStartDay: 3, timezone: "Europe/Berlin" });

      const rows = await db!.selectFrom("household_preference").selectAll().where("household_id", "=", HH_FRESH).execute();
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ week_start_day: 3, timezone: "Europe/Berlin" });
      expect(new Date(rows[0].updated_at).getTime()).toBeGreaterThanOrEqual(new Date(first.updated_at).getTime());
      expect(new Date(rows[0].created_at).getTime()).toBe(new Date(first.created_at).getTime());
    });

    it("a timezone change moves 'today' in the week read without moving any entry", async () => {
      const entry = await addRecipe(HH_A, DID_A, MON, "dinner", R1);
      await prefs.writeHouseholdPreferences(HH_A, { weekStartDay: 1, timezone: "Pacific/Kiritimati" });

      const week = await plan.readMealPlanWeek(db!, DID_A, HH_A, MON);
      expect(week.timezone).toBe("Pacific/Kiritimati");
      expect(week.today).toBe(todayIn("Pacific/Kiritimati"));
      expect(weekStartFor(week.today, 1)).toBe(weekStartFor(todayIn("Pacific/Kiritimati"), 1));
      // The entry is a calendar date and never moves (§2.3).
      expect((await rawEntry(entry))?.plan_date).toBe(MON);
    });
  });
});
