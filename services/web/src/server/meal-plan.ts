import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import type { Kysely } from "kysely";
import * as z from "zod";
import type { DB } from "#/db/types";
import { blobImageUrl } from "#/lib/atproto/images";
import { MEAL_SLOTS, type MealSlot, type PlanDate, daysBetween, isPlanDate, shiftDays, todayIn, weekDates, weekStartFor } from "#/lib/plan/week";
import { deriveSource } from "#/lib/recipe-provenance";
import type { CopiedWeek, CreatedPlanEntry, PlanDay, PlanEntry, PlanNoteEntry, PlanRecipeEntry, PlanWeek, PlannedUsage } from "#/lib/api/types";

/**
 * Meal-planner server functions (plan §6).
 *
 * Same shape as `server/household-recipes.ts`: every handler resolves the caller
 * DID from the server-validated session, the active household from
 * `session.active_household_id` (NEVER a client argument), and gates through
 * `assertMember` and/or `householdScopedQuery` — the membership join IS the
 * authorization. Every write additionally re-asserts `household_id` in its
 * `WHERE`, so a leaked or guessed `entryId` from another household is inert.
 *
 * Role is deliberately not consulted (D1): any live member may plan, move, cook
 * and remove. A household plans together.
 *
 * Server-only imports (`getDb`, kysely `sql`, authz/session) are pulled in with
 * dynamic `import()` inside each handler so this module stays safe to reference
 * from the client bundle.
 *
 * Every server fn below is a thin wrapper — session + `assertMember`, then a
 * plain exported function that takes `(db, did, householdId, input)` and holds
 * ALL of the behaviour (`readMealPlanWeek`, `addRecipesToPlan`, `movePlanEntry`,
 * …). Two reasons: server-side callers that already hold a validated DID and
 * household id can reuse the logic without a session round trip (the `.ics`
 * route does exactly that), and the logic is reachable from
 * `meal-plan.db.test.ts` without faking a session. The wrappers are the ONLY
 * place `active_household_id` is read, so the household still cannot come from
 * a client argument.
 */

// --- §6.0 shared shapes -------------------------------------------------

/**
 * The wire DTOs this module returns are declared in the port's `types.ts` and
 * imported from there (offline plan §4.3 / §7): the client caches these shapes
 * in IndexedDB, versions them, and must be able to name them without importing
 * a server module — so it owns the declaration. Re-exported here for the
 * server-side callers that already reach for them through this module.
 */
export type { CopiedWeek, CreatedPlanEntry, PlanDay, PlanEntry, PlanNoteEntry, PlanRecipeEntry, PlanWeek, PlannedUsage };

// --- validators ---------------------------------------------------------

/**
 * A calendar date on the wire. The regex is the cheap gate; `isPlanDate` is the
 * real one — it rejects shapes like "2026-02-31" that parse but do not exist.
 */
const planDate = z.string().refine(isPlanDate, { message: "Invalid date." });

const weekInput = z.object({ week: planDate.optional() }).optional();

/** Mirrors the `meal_plan_entry_slot_check` DB constraint (§6.10). */
const mealSlot = z.enum(["breakfast", "lunch", "dinner", "snack"]);

/**
 * An entry id. Ids are app-minted 26-char ULIDs, but the shape is deliberately
 * NOT asserted — the same rule recipe ids follow (`AGENTS.md`): existence in
 * the caller's household is the only source of truth, and every write re-asserts
 * `household_id`, so a guessed id from another household is inert regardless of
 * how well-formed it looks. The cap only keeps a hostile parameter bounded.
 */
const entryId = z.string().min(1).max(128);

/** §6.3: notes are 1–2000 characters AFTER trimming. */
const NOTE_MAX = 2000;

/**
 * Trim first, then measure. The over-generous pre-trim cap stops a megabyte of
 * whitespace from reaching the trim; the real limit is applied by the callers
 * below, which differ on whether an empty result is legal (add: no; update:
 * yes, it means "delete this note").
 */
const noteBody = z
  .string()
  .max(NOTE_MAX * 4)
  .transform((value) => value.trim());

// --- helpers ------------------------------------------------------------

/**
 * Resolve `{ did, householdId }` for a household-scoped handler. Mirrors
 * `server/household-recipes.ts`: DID from the validated session, household from
 * the session. Fails closed when there is no active household.
 */
async function activeContext(): Promise<{ did: string; householdId: string }> {
  const { getServerSession } = await import("./household/session");
  const { NotAMemberError } = await import("./household/errors");
  const { redirect } = await import("@tanstack/react-router");
  const session = await getServerSession();
  const did = session?.user.did ?? null;
  if (!did) throw redirect({ to: "/login" });
  const householdId = session?.session.active_household_id ?? null;
  if (!householdId) throw new NotAMemberError();
  return { did, householdId };
}

/** total_time_seconds → { minutes, display } ("1h 30m" / "45m"). Mirrors household-recipes.ts. */
function minutesDisplay(totalSeconds: number | null | undefined): { minutes: number | null; display: string | null } {
  if (!totalSeconds || totalSeconds <= 0) return { minutes: null, display: null };
  const minutes = Math.round(totalSeconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const display = h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  return { minutes, display };
}

/**
 * Resolve a set of DIDs to display handles in ONE query (D17). A household has
 * a handful of members, so this is one small `where did in (…)` per week read
 * rather than a lookup per entry. `atproto_repo.handle` is the same source
 * `getHouseholdRecipe`'s `addedByHandle` uses. An unresolvable DID yields null
 * and the UI simply omits the line.
 */
const resolveHandles = createServerOnlyFn(async (dids: Array<string | null>): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  const distinct = [...new Set(dids.filter((d): d is string => Boolean(d)))];
  if (!distinct.length) return out;
  const { getDb } = await import("#/lib/db");
  const rows = await getDb().selectFrom("atproto_repo").select(["did", "handle"]).where("did", "in", distinct).execute();
  for (const row of rows) if (row.handle) out.set(row.did, `@${row.handle}`);
  return out;
});

// --- §3.6 ordering: lock the slot, rewrite `position` densely --------------

/** The unit every ordering lock is taken on: one `(plan_date, slot)` bucket. */
interface SlotKey {
  date: PlanDate;
  slot: MealSlot;
}

/**
 * Step 1 of §3.6: `SELECT id … ORDER BY position, created_at FOR UPDATE`.
 *
 * The row locks are what serialize two household members dropping into the same
 * slot at the same moment — without them both would read the same tail length
 * and both would claim the same `position`. Returns the live ids in canonical
 * read order, which is also the order the rewrite in `renumberSlot` restores.
 *
 * Caveat worth knowing: `FOR UPDATE` locks rows, so two concurrent inserts into
 * an *empty* slot are not serialized by it. Nothing breaks — `position` carries
 * no unique constraint, `created_at` breaks the tie deterministically, and the
 * next write to that slot renumbers it densely. Serializing empty slots would
 * need a lock on a parent row that does not exist, which is a lot of table for
 * a cosmetic ordering guarantee.
 */
async function lockSlot(trx: Kysely<DB>, householdId: string, key: SlotKey): Promise<string[]> {
  const { sql } = await import("kysely");
  const rows = await trx
    .selectFrom("meal_plan_entry")
    .select("id")
    .where("household_id", "=", householdId)
    .where("slot", "=", key.slot)
    .where("deleted_at", "is", null)
    .where(sql<boolean>`plan_date = ${key.date}::date`)
    .orderBy("position")
    .orderBy("created_at")
    .forUpdate()
    .execute();
  return rows.map((row) => row.id);
}

/**
 * Step 3 of §3.6: rewrite `position = 0..n-1` over the ids in the order given.
 *
 * A loop rather than one `UPDATE … FROM (VALUES …)`: a slot holds single digits
 * of entries, this only ever runs inside the transaction that already holds
 * their locks, and the readable version is the one a future reorder feature can
 * splice an index into. `household_id` is repeated in the predicate so the
 * statement is inert against another household's row even if an id leaked into
 * the list.
 */
async function renumberSlot(trx: Kysely<DB>, householdId: string, ids: string[]): Promise<void> {
  for (let position = 0; position < ids.length; position++) {
    await trx.updateTable("meal_plan_entry").set({ position }).where("id", "=", ids[position]).where("household_id", "=", householdId).execute();
  }
}

/**
 * A total order over slot keys, so a transaction that has to lock two slots
 * always takes them in the same sequence and two opposite moves cannot deadlock
 * each other.
 */
function compareSlotKeys(a: SlotKey, b: SlotKey): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return MEAL_SLOTS.indexOf(a.slot) - MEAL_SLOTS.indexOf(b.slot);
}

function sameSlot(a: SlotKey, b: SlotKey): boolean {
  return a.date === b.date && a.slot === b.slot;
}

/**
 * Read one live entry's location, scoped to the household. Returns null when
 * the id belongs to another household, to a soft-deleted row, or to nothing —
 * all three are the same answer to a caller and none of them may be
 * distinguishable from outside (§6.10).
 */
async function readEntrySlot(db: Kysely<DB>, householdId: string, id: string): Promise<{ kind: string; key: SlotKey } | null> {
  const { sql } = await import("kysely");
  const row = await db
    .selectFrom("meal_plan_entry")
    .select(["kind", "slot", sql<string>`to_char(plan_date, 'YYYY-MM-DD')`.as("plan_date")])
    .where("id", "=", id)
    .where("household_id", "=", householdId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) return null;
  const slot = MEAL_SLOTS.find((s) => s === row.slot);
  if (!slot) return null;
  return { kind: row.kind, key: { date: row.plan_date, slot } };
}

/** Empty week skeleton: all 7 days, all 4 slots, so the UI never synthesizes it. */
function emptyDays(dates: PlanDate[], today: PlanDate): PlanDay[] {
  return dates.map((date) => ({
    date,
    isToday: date === today,
    isPast: date < today,
    slots: { breakfast: [], lunch: [], dinner: [], snack: [] },
  }));
}

// --- §6.1 getMealPlanWeek -----------------------------------------------

/**
 * The whole visible week in one payload.
 *
 * `week` is a hint, not a command: the server re-snaps it with `weekStartFor`
 * against the household's `week_start_day`, so a client cannot pin the grid to
 * a mid-week offset (§5). Omitted ⇒ the week containing "today" in the
 * household timezone.
 */
export const getMealPlanWeek = createServerFn({ method: "GET" })
  .validator((data: unknown) => weekInput.parse(data) ?? {})
  .handler(async ({ data }): Promise<PlanWeek> => {
    const { getDb } = await import("#/lib/db");
    const { did, householdId } = await activeContext();
    return readMealPlanWeek(getDb(), did, householdId, data?.week);
  });

/**
 * Today, as the household reckons it.
 *
 * The date a client picks has to be anchored to the household timezone like
 * every other plan date (§2.3) — a member in Tokyo planning "tonight" must land
 * on the same row as one in Chicago reading the same plan, and the browser's own
 * clock cannot answer that. This exists rather than reusing `getMealPlanWeek`
 * for surfaces that need the anchor but not the week: "add to meal planner" from
 * a recipe cares about which dates it may offer, not about what is already in
 * them.
 */
export const getPlanToday = createServerFn({ method: "GET" }).handler(async (): Promise<{ today: PlanDate; timezone: string }> => {
  const { readHouseholdPreferences } = await import("./household/preferences");
  const { assertMember } = await import("./authz");
  const { did, householdId } = await activeContext();
  await assertMember(did, householdId);
  const { timezone } = await readHouseholdPreferences(householdId);
  return { today: todayIn(timezone), timezone };
});

/**
 * The query behind `getMealPlanWeek`, callable directly by other server-side
 * readers that already hold a validated DID + household id — the `.ics` route
 * (§9.3) is not a server function and would otherwise duplicate this whole
 * join. Same shape and contract as `readPlannedUsage` below: authorization is
 * the caller's responsibility to *start*, and `householdScopedQuery` finishes
 * it, so a non-member simply selects nothing.
 *
 * `week` is still a hint, not a command: it is re-snapped with `weekStartFor`
 * here, not by the caller.
 */
export async function readMealPlanWeek(db: Kysely<DB>, did: string, householdId: string, week?: PlanDate): Promise<PlanWeek> {
  const { sql } = await import("kysely");
  const { householdScopedQuery } = await import("./household/scoped-query");
  const { readHouseholdPreferences } = await import("./household/preferences");

  const { weekStartDay, timezone } = await readHouseholdPreferences(householdId);
  const today = todayIn(timezone);
  const weekStart = weekStartFor(week ?? today, weekStartDay);
  const dates = weekDates(weekStart);
  const weekEnd = dates[6];

  const rows = await householdScopedQuery(db, did, householdId)
    .innerJoin("meal_plan_entry as mpe", "mpe.household_id", "hm.household_id")
    .leftJoin("recipe as r", "r.id", "mpe.recipe_id")
    // `inBox` is per-household, so this join is scoped to the same household
    // the membership row already pinned.
    .leftJoin("household_recipe as hr", (join) => join.onRef("hr.recipe_id", "=", "mpe.recipe_id").onRef("hr.household_id", "=", "mpe.household_id"))
    .leftJoin("recipe_image as img", (join) => join.onRef("img.recipe_id", "=", "r.id").on("img.ordinal", "=", 0))
    .leftJoin("recipe_attribution as attr", "attr.recipe_id", "r.id")
    .leftJoin("atproto_repo as repo", "repo.did", "r.did")
    .leftJoin("atproto_collection_recipe as acr", (join) => join.onRef("acr.did", "=", "r.did").onRef("acr.rkey", "=", "r.rkey"))
    .where("mpe.deleted_at", "is", null)
    // Bound as parameters and cast to `date` in SQL. `plan_date` is a Postgres
    // `date`, and the `pg` driver would otherwise hand it back as a JS `Date`
    // at local midnight — exactly the instant-vs-calendar-date confusion §2.3
    // exists to prevent. Every read of it goes out as text instead, so a date
    // is a `YYYY-MM-DD` string end to end.
    .where(sql<boolean>`mpe.plan_date between ${weekStart}::date and ${weekEnd}::date`)
    .select([
      "mpe.id as id",
      "mpe.kind as kind",
      "mpe.slot as slot",
      "mpe.position as position",
      "mpe.body as body",
      "mpe.recipe_id as recipe_id",
      "mpe.cooked_at as cooked_at",
      "mpe.cooked_by_did as cooked_by_did",
      "mpe.created_by_did as created_by_did",
      sql<string>`to_char(mpe.plan_date, 'YYYY-MM-DD')`.as("plan_date"),
      "r.name as name",
      "r.origin as origin",
      "r.did as recipe_did",
      "r.visibility as visibility",
      "r.uri as uri",
      "r.total_time_seconds as total_time_seconds",
      "hr.recipe_id as boxed_recipe_id",
      "img.blob_cid as blob_cid",
      "img.blob_mime as blob_mime",
      "attr.display_name as attr_display_name",
      "attr.author as attr_author",
      "attr.publisher as attr_publisher",
      "attr.url as attr_url",
      "repo.handle as repo_handle",
      "acr.deleted_at as acr_deleted_at",
      "acr.validation_status as acr_validation_status",
    ])
    .orderBy("mpe.plan_date")
    .orderBy("mpe.slot")
    .orderBy("mpe.position")
    .orderBy("mpe.created_at")
    .execute();

  const handles = await resolveHandles(rows.flatMap((r) => [r.created_by_did, r.cooked_by_did]));

  const days = emptyDays(dates, today);
  const byDate = new Map(days.map((d) => [d.date, d]));
  let recipeEntryCount = 0;
  let cookedCount = 0;

  for (const row of rows) {
    const day = byDate.get(row.plan_date);
    // A row outside the requested range can't happen (the WHERE bounds it),
    // but bucketing defensively beats throwing on one bad row.
    if (!day) continue;
    const slot = MEAL_SLOTS.find((s) => s === row.slot);
    if (!slot) continue;
    const addedByHandle = handles.get(row.created_by_did) ?? null;

    if (row.kind === "note") {
      day.slots[slot].push({ id: row.id, kind: "note", position: row.position, body: row.body ?? "", cookedAt: null, addedByHandle });
      continue;
    }

    // kind = 'recipe'. The CHECK constraint guarantees recipe_id is present,
    // and the RESTRICT FK guarantees the `recipe` row still exists.
    if (!row.recipe_id || !row.name) continue;
    const { minutes, display } = minutesDisplay(row.total_time_seconds);
    const source = deriveSource({
      repoHandle: row.repo_handle,
      attrDisplayName: row.attr_display_name,
      attrAuthor: row.attr_author,
      attrPublisher: row.attr_publisher,
      attrUrl: row.attr_url,
    });
    // Same formulas as the recipes index, so the planner's flags mean exactly
    // what the box's flags mean.
    const unavailable = row.origin === "sync" && (row.acr_deleted_at !== null || row.acr_validation_status == null || row.acr_validation_status !== "valid");
    recipeEntryCount += 1;
    if (row.cooked_at) cookedCount += 1;

    day.slots[slot].push({
      id: row.id,
      kind: "recipe",
      position: row.position,
      recipeId: row.recipe_id,
      title: row.name,
      imageUrl: row.recipe_did && row.blob_cid ? blobImageUrl(row.recipe_did, row.blob_cid, row.blob_mime, "feed_thumbnail") : null,
      totalMinutes: minutes,
      totalTimeDisplay: display,
      source,
      inBox: row.boxed_recipe_id !== null,
      unavailable,
      unpublished: row.visibility !== "public" || row.uri == null,
      cookedAt: row.cooked_at ? new Date(row.cooked_at).toISOString() : null,
      cookedByHandle: row.cooked_by_did ? (handles.get(row.cooked_by_did) ?? null) : null,
      addedByHandle,
    });
  }

  let emptySlotCount = 0;
  for (const day of days) for (const slot of MEAL_SLOTS) if (day.slots[slot].length === 0) emptySlotCount += 1;

  return {
    weekStart,
    weekEnd,
    timezone,
    weekStartDay,
    today,
    days,
    recipeEntryCount,
    emptySlotCount,
    cookedCount,
  };
}

// --- §6.8 getPlannedUsageForRecipe --------------------------------------

/**
 * "Is this recipe on the plan, and when next?" — powers the remove-from-box
 * warning (§7.2). Counts LIVE entries only; "upcoming" is measured against
 * today in the household timezone, so a member in Tokyo and one in Chicago see
 * the same answer.
 */
export const getPlannedUsageForRecipe = createServerFn({ method: "GET" })
  .validator((data: unknown) => z.object({ recipeId: z.string().min(1).max(512) }).parse(data))
  .handler(async ({ data }): Promise<PlannedUsage> => {
    const { getDb } = await import("#/lib/db");
    const { did, householdId } = await activeContext();
    const { assertMember } = await import("./authz");
    await assertMember(did, householdId);
    return readPlannedUsage(getDb(), householdId, data.recipeId);
  });

/**
 * The query behind `getPlannedUsageForRecipe`, callable directly by other
 * server-side readers that have already authorized — `getHouseholdRecipe`
 * embeds it in its detail payload so the remove flow needs no extra round trip.
 */
export async function readPlannedUsage(db: Kysely<DB>, householdId: string, recipeId: string): Promise<PlannedUsage> {
  const { sql } = await import("kysely");
  const { readHouseholdPreferences } = await import("./household/preferences");
  const { timezone } = await readHouseholdPreferences(householdId);
  const today = todayIn(timezone);

  const rows = await db
    .selectFrom("meal_plan_entry as mpe")
    .where("mpe.household_id", "=", householdId)
    .where("mpe.recipe_id", "=", recipeId)
    .where("mpe.deleted_at", "is", null)
    .select(sql<string>`to_char(mpe.plan_date, 'YYYY-MM-DD')`.as("plan_date"))
    .orderBy("mpe.plan_date")
    .execute();

  const dates: PlanDate[] = rows.map((r) => r.plan_date);
  const upcoming = dates.filter((d) => d >= today);
  return { total: dates.length, upcoming: upcoming.length, nextDate: upcoming[0] ?? null };
}

// --- §6.9 getCookedCandidates -------------------------------------------

/**
 * Live, not-yet-cooked entries for `recipeId` on today's date — the cook-mode
 * finish prompt (§7.1). An empty array means no prompt, which is why this
 * returns a list rather than throwing on "no plan": cook mode must work fine
 * for someone who never opens the planner.
 */
export const getCookedCandidates = createServerFn({ method: "GET" })
  .validator((data: unknown) => z.object({ recipeId: z.string().min(1).max(512) }).parse(data))
  .handler(async ({ data }): Promise<Array<{ entryId: string; slot: MealSlot; date: PlanDate }>> => {
    const { getDb } = await import("#/lib/db");
    const { sql } = await import("kysely");
    const { readHouseholdPreferences } = await import("./household/preferences");
    const { assertMember } = await import("./authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);

    const { timezone } = await readHouseholdPreferences(householdId);
    const today = todayIn(timezone);

    const rows = await getDb()
      .selectFrom("meal_plan_entry as mpe")
      .where("mpe.household_id", "=", householdId)
      .where("mpe.recipe_id", "=", data.recipeId)
      .where("mpe.kind", "=", "recipe")
      .where("mpe.deleted_at", "is", null)
      .where("mpe.cooked_at", "is", null)
      .where(sql<boolean>`mpe.plan_date = ${today}::date`)
      .select(["mpe.id as id", "mpe.slot as slot"])
      .orderBy("mpe.position")
      .execute();

    return rows.flatMap((row) => {
      const slot = MEAL_SLOTS.find((s) => s === row.slot);
      return slot ? [{ entryId: row.id, slot, date: today }] : [];
    });
  });

// --- §6.2 addMealPlanRecipes --------------------------------------------

/**
 * Multi-select add: several boxed recipes land in one slot, in the order the
 * picker listed them, appended to that slot's tail (D14).
 *
 * The membership check that matters here is the BOX, not the recipe table: a
 * recipe is plannable because this household keeps it, not because it happens
 * to be public. That also means the check cannot be skipped by guessing a
 * recipe id — an unboxed id fails the whole call rather than being silently
 * dropped, so the client never half-succeeds.
 *
 * Duplicates are accepted on purpose (D4): the same recipe twice in a slot is a
 * double batch, not a mistake.
 */
export const addMealPlanRecipes = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z
      .object({
        date: planDate,
        slot: mealSlot,
        // 20 is §6.10's cap: the picker is a household's own box, not a bulk
        // import surface.
        recipeIds: z.array(z.string().min(1).max(512)).min(1).max(20),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<CreatedPlanEntry[]> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return addRecipesToPlan(getDb(), did, householdId, data);
  });

/**
 * The body of `addMealPlanRecipes`, callable by an already-authorized
 * server-side caller. Same contract as `readMealPlanWeek`: the caller supplies a
 * DID and a household id it has already validated, and every statement in here
 * re-asserts `household_id` regardless.
 */
export const addRecipesToPlan = createServerOnlyFn(
  async (db: Kysely<DB>, did: string, householdId: string, input: { date: PlanDate; slot: MealSlot; recipeIds: string[] }): Promise<CreatedPlanEntry[]> => {
    const { ulid } = await import("./household/ids");

    const boxed = await db
      .selectFrom("household_recipe")
      .select("recipe_id")
      .where("household_id", "=", householdId)
      // `in` over the DISTINCT ids: the input may legitimately repeat one (D4).
      .where("recipe_id", "in", [...new Set(input.recipeIds)])
      .execute();
    const inBox = new Set(boxed.map((row) => row.recipe_id));
    if (input.recipeIds.some((id) => !inBox.has(id))) throw new Error("That recipe is not in this household's box.");

    const key: SlotKey = { date: input.date, slot: input.slot };
    return db.transaction().execute(async (trx) => {
      const existing = await lockSlot(trx, householdId, key);
      const created: CreatedPlanEntry[] = [];
      let position = existing.length;
      for (const recipeId of input.recipeIds) {
        const id = ulid();
        await trx
          .insertInto("meal_plan_entry")
          .values({
            id,
            household_id: householdId,
            // `plan_date` is a `date` column and Kysely accepts the string
            // straight through — no Date object ever crosses this boundary (§2.3).
            plan_date: input.date,
            slot: input.slot,
            kind: "recipe",
            position,
            recipe_id: recipeId,
            created_by_did: did,
          })
          .execute();
        created.push({ id, kind: "recipe", position, recipeId });
        position += 1;
      }
      // The appends are already dense, but the rewrite also repairs any gap an
      // interrupted earlier write left behind in this slot.
      await renumberSlot(trx, householdId, existing.concat(created.map((entry) => entry.id)));
      return created;
    });
  },
);

// --- §6.3 addMealPlanNote / updateMealPlanNote --------------------------

/**
 * A free-text note in a slot ("Leftovers", "Sam cooks tonight"). Notes are
 * slot-level only (D3) and share the entry table and its ordering with recipes,
 * so a note can sit between two recipes and stay there.
 */
export const addMealPlanNote = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z
      .object({
        date: planDate,
        slot: mealSlot,
        body: noteBody.refine((body) => body.length >= 1 && body.length <= NOTE_MAX, { message: `A note needs 1–${NOTE_MAX} characters.` }),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<CreatedPlanEntry> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return addNoteToPlan(getDb(), did, householdId, data);
  });

/** The body of `addMealPlanNote`. See `addRecipesToPlan` for the contract. */
export const addNoteToPlan = createServerOnlyFn(
  async (db: Kysely<DB>, did: string, householdId: string, input: { date: PlanDate; slot: MealSlot; body: string }): Promise<CreatedPlanEntry> => {
    const { ulid } = await import("./household/ids");

    const key: SlotKey = { date: input.date, slot: input.slot };
    return db.transaction().execute(async (trx) => {
      const existing = await lockSlot(trx, householdId, key);
      const id = ulid();
      const position = existing.length;
      await trx
        .insertInto("meal_plan_entry")
        .values({
          id,
          household_id: householdId,
          plan_date: input.date,
          slot: input.slot,
          kind: "note",
          position,
          body: input.body,
          created_by_did: did,
        })
        .execute();
      await renumberSlot(trx, householdId, existing.concat([id]));
      return { id, kind: "note" as const, position, recipeId: null };
    });
  },
);

/**
 * Edit a note in place. An empty body REMOVES it (§6.3) rather than storing a
 * blank — the same rule `household_recipe_note` follows. Clearing the field is
 * the shortest path to "I don't need this note any more", and a blank card
 * would be an invisible, undeletable-looking artifact.
 */
export const updateMealPlanNote = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z
      .object({
        entryId,
        body: noteBody.refine((body) => body.length <= NOTE_MAX, { message: `A note is at most ${NOTE_MAX} characters.` }),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<{ removed: boolean }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return updatePlanNote(getDb(), householdId, data);
  });

/** The body of `updateMealPlanNote`. See `addRecipesToPlan` for the contract. */
export async function updatePlanNote(db: Kysely<DB>, householdId: string, input: { entryId: string; body: string }): Promise<{ removed: boolean }> {
  const { sql } = await import("kysely");

  return db.transaction().execute(async (trx) => {
    const found = await readEntrySlot(trx, householdId, input.entryId);
    // `kind = 'note'` is checked here rather than trusted from the client, so
    // a recipe entry's id cannot be used to stuff text into `body` and trip
    // the `meal_plan_entry_recipe_shape_check` constraint.
    if (!found || found.kind !== "note") throw new Error("That note is no longer on the plan.");

    const ids = await lockSlot(trx, householdId, found.key);

    if (input.body === "") {
      await trx
        .updateTable("meal_plan_entry")
        .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
        .where("id", "=", input.entryId)
        .where("household_id", "=", householdId)
        .execute();
      await renumberSlot(
        trx,
        householdId,
        ids.filter((id) => id !== input.entryId),
      );
      return { removed: true };
    }

    await trx
      .updateTable("meal_plan_entry")
      .set({ body: input.body, updated_at: sql`now()` })
      .where("id", "=", input.entryId)
      .where("household_id", "=", householdId)
      .execute();
    return { removed: false };
  });
}

// --- §6.4 moveMealPlanEntry ---------------------------------------------

/**
 * Move an entry to another day and/or slot, APPENDING to the destination (D14).
 *
 * The drag drop and the popover's "Move to…" dialog both call exactly this —
 * the design says outright that the two do the same thing, so there is one code
 * path and the keyboard route cannot drift from the pointer route.
 *
 * Any date is legal, including the past (D6): a plan you are correcting after
 * the fact is still a plan. A move onto the entry's current slot is a no-op.
 */
export const moveMealPlanEntry = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ entryId, toDate: planDate, toSlot: mealSlot }).parse(data))
  .handler(async ({ data }): Promise<{ moved: boolean }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return movePlanEntry(getDb(), householdId, data);
  });

/** The body of `moveMealPlanEntry`. See `addRecipesToPlan` for the contract. */
export async function movePlanEntry(db: Kysely<DB>, householdId: string, input: { entryId: string; toDate: PlanDate; toSlot: MealSlot }): Promise<{ moved: boolean }> {
  const { sql } = await import("kysely");

  const to: SlotKey = { date: input.toDate, slot: input.toSlot };

  return db.transaction().execute(async (trx) => {
    const hint = await readEntrySlot(trx, householdId, input.entryId);
    if (!hint) throw new Error("That entry is no longer on the plan.");
    if (sameSlot(hint.key, to)) return { moved: false };

    // Locks are taken in `compareSlotKeys` order so two members moving
    // entries in opposite directions between the same two slots queue up
    // instead of deadlocking.
    const keys = [hint.key, to].sort(compareSlotKeys);
    const locked = new Map<string, string[]>();
    for (const key of keys) locked.set(`${key.date}|${key.slot}`, await lockSlot(trx, householdId, key));

    // Re-read under the lock. In the rare case a concurrent move relocated
    // the entry between the hint read and the lock, the true source slot is
    // locked here too so it still gets renumbered — last-write-wins on the
    // destination (D10), but never a permanent gap in the slot it left.
    const actual = await readEntrySlot(trx, householdId, input.entryId);
    if (!actual) throw new Error("That entry is no longer on the plan.");
    if (sameSlot(actual.key, to)) return { moved: false };
    const actualKey = `${actual.key.date}|${actual.key.slot}`;
    if (!locked.has(actualKey)) locked.set(actualKey, await lockSlot(trx, householdId, actual.key));

    const destKey = `${to.date}|${to.slot}`;
    const destIds = (locked.get(destKey) ?? []).filter((id) => id !== input.entryId);

    await trx
      .updateTable("meal_plan_entry")
      .set({ plan_date: input.toDate, slot: input.toSlot, position: destIds.length, updated_at: sql`now()` })
      .where("id", "=", input.entryId)
      .where("household_id", "=", householdId)
      .execute();

    // Destination gets the entry at its tail; every other touched slot closes
    // the hole the entry left.
    await renumberSlot(trx, householdId, destIds.concat([input.entryId]));
    for (const [key, ids] of locked) {
      if (key === destKey) continue;
      await renumberSlot(
        trx,
        householdId,
        ids.filter((id) => id !== input.entryId),
      );
    }

    return { moved: true };
  });
}

// --- §6.5 removeMealPlanEntry -------------------------------------------

/**
 * Soft delete (D6): the row survives with `deleted_at` set, which is what keeps
 * the recipe FK alive and a restored plan whole. Idempotent — removing an entry
 * that is already gone reports `{ removed: false }` rather than throwing, so a
 * double-click or a stale card cannot produce an error toast.
 */
export const removeMealPlanEntry = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ entryId }).parse(data))
  .handler(async ({ data }): Promise<{ removed: boolean }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return removePlanEntry(getDb(), householdId, data);
  });

/** The body of `removeMealPlanEntry`. See `addRecipesToPlan` for the contract. */
export async function removePlanEntry(db: Kysely<DB>, householdId: string, input: { entryId: string }): Promise<{ removed: boolean }> {
  const { sql } = await import("kysely");

  return db.transaction().execute(async (trx) => {
    const found = await readEntrySlot(trx, householdId, input.entryId);
    if (!found) return { removed: false };

    const ids = await lockSlot(trx, householdId, found.key);
    await trx
      .updateTable("meal_plan_entry")
      .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
      .where("id", "=", input.entryId)
      .where("household_id", "=", householdId)
      .where("deleted_at", "is", null)
      .execute();
    await renumberSlot(
      trx,
      householdId,
      ids.filter((id) => id !== input.entryId),
    );
    return { removed: true };
  });
}

// --- §6.6 setMealPlanEntryCooked ----------------------------------------

/**
 * Mark an entry cooked, or take the mark back. `cooked_by_did` is provenance
 * ("cooked by @sam"), not ownership — any live member may set or clear it (D1).
 *
 * Recipe entries only: notes are never cooked, and the `kind = 'recipe'`
 * predicate makes that a no-match rather than a special case. Marking a future
 * date is permitted — the UI may find it odd, the server does not care (§6.6).
 */
export const setMealPlanEntryCooked = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ entryId, cooked: z.boolean() }).parse(data))
  .handler(async ({ data }): Promise<{ cookedAt: string | null }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return setPlanEntryCooked(getDb(), did, householdId, data);
  });

/** The body of `setMealPlanEntryCooked`. See `addRecipesToPlan` for the contract. */
export async function setPlanEntryCooked(db: Kysely<DB>, did: string, householdId: string, input: { entryId: string; cooked: boolean }): Promise<{ cookedAt: string | null }> {
  const { sql } = await import("kysely");

  const updated = await db
    .updateTable("meal_plan_entry")
    .set({
      cooked_at: input.cooked ? sql`now()` : null,
      cooked_by_did: input.cooked ? did : null,
      updated_at: sql`now()`,
    })
    .where("id", "=", input.entryId)
    .where("household_id", "=", householdId)
    .where("kind", "=", "recipe")
    .where("deleted_at", "is", null)
    .returning("cooked_at")
    .executeTakeFirst();

  if (!updated) throw new Error("That entry can't be marked cooked.");
  return { cookedAt: updated.cooked_at ? new Date(updated.cooked_at).toISOString() : null };
}

// --- §6.7 copyMealPlanWeek ----------------------------------------------

/**
 * Copy a whole week onto another week, same weekday to same weekday (§6.7).
 *
 * Both week params are hints and are re-snapped server-side, exactly as
 * `getMealPlanWeek` re-snaps its `week`: the mapping is a whole-week offset in
 * days, so a client that sent a mid-week date cannot smear Tuesday's dinner onto
 * a Wednesday.
 *
 * Copies recipes AND notes; every copy is a new row with a new ULID, the caller
 * as `created_by_did`, and `cooked_at`/`cooked_by_did` cleared — a plan you have
 * not cooked yet is the whole point of copying it forward.
 *
 * `mode`:
 * - `append` keeps whatever the destination already holds and lands the copies
 *   after it, per slot, in source order.
 * - `replace` soft-deletes the destination week's live entries first.
 *
 * An empty source week is a no-op returning `{ copied: 0 }` rather than an
 * error: "there was nothing to copy" is information, not a failure, and the UI
 * says so in a plain toast.
 */
export const copyMealPlanWeek = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ fromWeek: planDate, toWeek: planDate, mode: z.enum(["append", "replace"]) }).parse(data))
  .handler(async ({ data }): Promise<CopiedWeek> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return copyPlanWeek(getDb(), did, householdId, data);
  });

/** The body of `copyMealPlanWeek`. See `addRecipesToPlan` for the contract. */
export const copyPlanWeek = createServerOnlyFn(
  async (db: Kysely<DB>, did: string, householdId: string, input: { fromWeek: PlanDate; toWeek: PlanDate; mode: "append" | "replace" }): Promise<CopiedWeek> => {
    const { sql } = await import("kysely");
    const { readHouseholdPreferences } = await import("./household/preferences");
    const { ulid } = await import("./household/ids");

    const { weekStartDay } = await readHouseholdPreferences(householdId);
    const fromWeek = weekStartFor(input.fromWeek, weekStartDay);
    const toWeek = weekStartFor(input.toWeek, weekStartDay);
    const fromWeekEnd = weekDates(fromWeek)[6];
    const toWeekEnd = weekDates(toWeek)[6];
    const offset = daysBetween(fromWeek, toWeek);

    return db.transaction().execute(async (trx) => {
      // Read the source BEFORE the `replace` wipe. The two weeks are snapped
      // week starts, so they are either disjoint or identical — and copying a
      // week onto itself in `replace` mode is then a rebuild (same entries,
      // new ids, cooked marks cleared) rather than a self-inflicted delete.
      const rows = await trx
        .selectFrom("meal_plan_entry")
        .select(["id", "kind", "slot", "body", "recipe_id", sql<string>`to_char(plan_date, 'YYYY-MM-DD')`.as("plan_date")])
        .where("household_id", "=", householdId)
        .where("deleted_at", "is", null)
        .where(sql<boolean>`plan_date between ${fromWeek}::date and ${fromWeekEnd}::date`)
        .orderBy("plan_date")
        .orderBy("slot")
        .orderBy("position")
        .orderBy("created_at")
        .execute();

      if (rows.length === 0) return { copied: 0, fromWeek, toWeek, toWeekEnd };

      if (input.mode === "replace") {
        await trx
          .updateTable("meal_plan_entry")
          .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
          .where("household_id", "=", householdId)
          .where("deleted_at", "is", null)
          .where(sql<boolean>`plan_date between ${toWeek}::date and ${toWeekEnd}::date`)
          .execute();
      }

      // Bucket by destination slot so each slot is locked and renumbered
      // exactly once, however many entries land in it.
      const buckets = new Map<string, { key: SlotKey; rows: typeof rows }>();
      for (const row of rows) {
        const slot = MEAL_SLOTS.find((s) => s === row.slot);
        if (!slot) continue;
        const key: SlotKey = { date: shiftDays(row.plan_date, offset), slot };
        const id = `${key.date}|${key.slot}`;
        const bucket = buckets.get(id);
        if (bucket) bucket.rows.push(row);
        else buckets.set(id, { key, rows: [row] });
      }

      // Same lock discipline as `moveMealPlanEntry`: slots are taken in
      // `compareSlotKeys` order so a copy and a concurrent move between the
      // same slots queue up instead of deadlocking.
      const ordered = [...buckets.values()].sort((a, b) => compareSlotKeys(a.key, b.key));
      let copied = 0;
      for (const bucket of ordered) {
        const existing = await lockSlot(trx, householdId, bucket.key);
        const created: string[] = [];
        let position = existing.length;
        for (const row of bucket.rows) {
          const id = ulid();
          await trx
            .insertInto("meal_plan_entry")
            .values({
              id,
              household_id: householdId,
              plan_date: bucket.key.date,
              slot: bucket.key.slot,
              kind: row.kind,
              position,
              body: row.body,
              recipe_id: row.recipe_id,
              created_by_did: did,
            })
            .execute();
          created.push(id);
          position += 1;
          copied += 1;
        }
        await renumberSlot(trx, householdId, existing.concat(created));
      }

      return { copied, fromWeek, toWeek, toWeekEnd };
    });
  },
);
