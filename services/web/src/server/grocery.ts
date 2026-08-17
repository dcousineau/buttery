import { createServerFn } from "@tanstack/react-start";
import type { Kysely } from "kysely";
import * as z from "zod";
import type { DB } from "#/db/types";
import { AISLES, type Aisle, aisleOrder, toAisle } from "#/lib/grocery/aisles";
import type { MergedRow } from "#/lib/grocery/merge";
import type { UnitDim } from "#/lib/grocery/units";
// `units.ts` is pure, tiny and carries no lexicon, so it is a static import
// while `categorize.ts` and `merge.ts` stay dynamic to keep the JSON lazy.
import { renderQuantity } from "#/lib/grocery/units";
import { type PlanDate, isPlanDate, shiftDays, weekStartFor } from "#/lib/plan/week";

/**
 * Grocery-list server functions (grocery-list plan §7).
 *
 * Same shape as `server/meal-plan.ts`: every handler resolves the caller DID
 * from the server-validated session, the active household from
 * `session.active_household_id` (NEVER a client argument), and gates through
 * `assertMember` — the membership check IS the authorization. Every write
 * additionally re-asserts `household_id` in its `WHERE`, so a leaked or guessed
 * `itemId` from another household is inert.
 *
 * Role is deliberately not consulted: any live member may add, check off and
 * remove. A household shops together.
 *
 * Server-only imports (`getDb`, kysely `sql`, authz/session) are pulled in with
 * dynamic `import()` inside each handler so this module stays safe to reference
 * from the client bundle. The **food lexicon** is loaded the same lazy way, one
 * level down in `lib/grocery/categorize.ts`, so the ~500KB of JSON never lands
 * in a response that categorizes nothing.
 *
 * Every server fn below is a thin wrapper — session + `assertMember`, then a
 * plain exported function taking `(db, did, householdId, input)` that holds ALL
 * of the behaviour. That is what lets `grocery.db.test.ts` reach the logic
 * without faking a session, and the wrappers stay the only place
 * `active_household_id` is read.
 */

// --- shared shapes -------------------------------------------------------

/** A row as the list renders it. */
export interface GroceryItemRow {
  id: string;
  foodSlug: string | null;
  displayName: string;
  aisle: Aisle;
  /** Rendered total: `1 lb 8 oz`, `2½ cups`, `3 cloves`. `null` when unknown. */
  quantityDisplay: string | null;
  /** Raw base-unit total, so the client can re-render after an inline edit. */
  quantity: number | null;
  unit: string | null;
  unitDim: string | null;
  isManual: boolean;
  checkedAt: string | null;
  checkedByHandle: string | null;
  /** The recipes that put this on the list, resolved to titles. */
  sources: GroceryItemSourceRow[];
}

export interface GroceryItemSourceRow {
  recipeId: string | null;
  title: string | null;
  /** The ingredient line, verbatim, as it read when it was added. */
  rawText: string;
  scale: number;
}

export interface GroceryListPayload {
  listId: string | null;
  items: GroceryItemRow[];
  /** Server time at read, so the client can apply the TTL without clock skew. */
  readAt: string;
  /** How long a checked row stays visible, in seconds (plan D10). */
  checkedTtlSeconds: number;
}

/** A candidate row in the confirm-preview dialog (plan D9). Nothing written. */
export interface GroceryPreviewRow {
  /** Stable within one preview; the client sends back the ones it wants. */
  key: string;
  foodSlug: string | null;
  nameNorm: string;
  displayName: string;
  aisle: Aisle;
  quantity: number | null;
  quantityMax: number | null;
  quantityDisplay: string | null;
  unit: string | null;
  /**
   * Not `string`: a preview row is handed straight back to `commitGroceryAdd`,
   * whose validator only accepts the three real dimensions. Widening this to
   * `string` makes that round trip fail to typecheck, which is exactly what
   * `grocery.db.test.ts` caught.
   */
  unitDim: UnitDim;
  mergeUnit: string | null;
  /** Shown but unchecked by default (plan D9). */
  isStaple: boolean;
  /** True when this food already has a live row that this would merge into. */
  mergesInto: string | null;
  sources: Array<{ recipeId: string | null; rawText: string; scale: number; quantityBase: number | null }>;
}

export interface GroceryPreview {
  rows: GroceryPreviewRow[];
  /** Recipes the preview drew from, for the dialog's header copy. */
  recipes: Array<{ recipeId: string; title: string; scale: number }>;
}

/** Checked rows stay visible for an hour, then retire from the default view. */
export const CHECKED_TTL_SECONDS = 60 * 60;

// --- validators ----------------------------------------------------------

/**
 * A recipe id. Ids are atproto rkeys, so the shape is deliberately NOT asserted
 * (`AGENTS.md`): a regex would reject real ids. Existence in the caller's
 * household is the only truth, and the box check below is what enforces it.
 */
const recipeId = z.string().min(1).max(512);

/** An item id. App-minted ULID; the cap only bounds a hostile parameter. */
const itemId = z.string().min(1).max(128);

const planDate = z.string().refine(isPlanDate, { message: "Invalid date." });

/** Mirrors `grocery_item_aisle_check`. */
const aisle = z.enum(AISLES);

/** Mirrors `grocery_item_unit_dim_check` and `UnitDim`. */
const unitDim = z.enum(["volume", "mass", "count"]);

/**
 * Scale is bounded on both ends. Zero would contribute nothing while claiming
 * to; the ceiling keeps a fat-fingered "20x" from rendering an absurd total.
 */
const scale = z.number().finite().gt(0).max(100);

/** A quantity in base units. Finite and non-negative; `null` means unknown. */
const quantity = z.number().finite().min(0).max(1_000_000).nullable();

/** Display strings are bounded so a hostile client cannot store a novel. */
const displayName = z.string().trim().min(1).max(200);

/**
 * 40 recipes is a whole plan week with room to spare, and the preview is a
 * household's own box rather than a bulk-import surface.
 */
const RECIPE_LIMIT = 40;

/** One preview cannot commit more rows than a large multi-recipe add produces. */
const ROW_LIMIT = 500;

const previewInput = z.object({
  recipes: z
    .array(z.object({ recipeId, scale: scale.optional() }))
    .max(RECIPE_LIMIT)
    .optional(),
  /** A week start; the server snaps it to the household's week-start day. */
  planWeek: planDate.optional(),
});

const commitRowInput = z.object({
  foodSlug: z.string().min(1).max(200).nullable(),
  nameNorm: z.string().min(1).max(200),
  displayName,
  aisle,
  quantity,
  quantityMax: quantity,
  unit: z.string().min(1).max(40).nullable(),
  unitDim: unitDim.nullable(),
  mergeUnit: z.string().min(1).max(40).nullable(),
  sources: z
    .array(
      z.object({
        recipeId: recipeId.nullable(),
        planEntryId: z.string().min(1).max(128).nullable().optional(),
        rawText: z.string().min(1).max(1000),
        scale: scale.default(1),
        quantityBase: quantity,
      }),
    )
    .min(1)
    .max(50),
});

// --- helpers -------------------------------------------------------------

/**
 * Resolve `{ did, householdId }` for a household-scoped handler. Mirrors
 * `server/meal-plan.ts`: DID from the validated session, household from the
 * session. Fails closed when there is no active household.
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

/** `numeric` comes back from `pg` as a string. Mirrors household-recipes.ts. */
function toNum(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Resolve DIDs to display handles in ONE query. Mirrors meal-plan.ts. */
async function resolveHandles(db: Kysely<DB>, dids: Array<string | null>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const distinct = [...new Set(dids.filter((d): d is string => Boolean(d)))];
  if (!distinct.length) return out;
  const rows = await db.selectFrom("atproto_repo").select(["did", "handle"]).where("did", "in", distinct).execute();
  for (const row of rows) if (row.handle) out.set(row.did, `@${row.handle}`);
  return out;
}

/**
 * Ingredient lines for a set of recipes, grouped by recipe id. Batched into one
 * query rather than one per recipe — a plan week is a dozen recipes.
 */
async function ingredientsFor(db: Kysely<DB>, recipeIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(recipeIds)];
  if (!ids.length) return out;

  const rows = await db.selectFrom("recipe_ingredient").select(["recipe_id", "text"]).where("recipe_id", "in", ids).orderBy("recipe_id").orderBy("ordinal").execute();

  for (const row of rows) {
    const bucket = out.get(row.recipe_id) ?? [];
    bucket.push(row.text);
    out.set(row.recipe_id, bucket);
  }
  return out;
}

/**
 * Assert every id is in this household's box, then return their titles.
 *
 * This is the real gate on `previewGroceryAdd`: `recipeId` is a client argument,
 * and without this check any recipe id in the corpus could be read through it.
 */
async function assertBoxed(db: Kysely<DB>, householdId: string, recipeIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(recipeIds)];
  if (!ids.length) return new Map();

  const rows = await db
    .selectFrom("household_recipe as hr")
    .innerJoin("recipe as r", "r.id", "hr.recipe_id")
    .select(["hr.recipe_id as recipe_id", "r.name as name"])
    .where("hr.household_id", "=", householdId)
    .where("hr.recipe_id", "in", ids)
    .execute();

  if (rows.length !== ids.length) throw new Error("That recipe is not in this household's box.");
  return new Map(rows.map((row) => [row.recipe_id, row.name ?? "Untitled"]));
}

/** The recipe ids planned in one week, in plan order. */
async function planWeekRecipeIds(db: Kysely<DB>, householdId: string, week: PlanDate): Promise<string[]> {
  const { sql } = await import("kysely");
  const { readHouseholdPreferences } = await import("./household/preferences");
  const { weekStartDay } = await readHouseholdPreferences(householdId);
  const weekStart = weekStartFor(week, weekStartDay);
  const weekEnd = shiftDays(weekStart, 6);

  const rows = await db
    .selectFrom("meal_plan_entry")
    .select("recipe_id")
    .where("household_id", "=", householdId)
    .where("kind", "=", "recipe")
    .where("deleted_at", "is", null)
    .where(sql<boolean>`plan_date between ${weekStart}::date and ${weekEnd}::date`)
    .orderBy("plan_date")
    .orderBy("slot")
    .orderBy("position")
    .execute();

  return rows.map((row) => row.recipe_id).filter((id): id is string => Boolean(id));
}

/** Identity of a row, as the live unique index computes it. */
function identityOf(row: { foodSlug: string | null; nameNorm: string; unitDim: string | null; mergeUnit: string | null }): string {
  return [row.foodSlug ?? row.nameNorm, row.unitDim ?? "", row.mergeUnit ?? ""].join("");
}

// --- §7 previewGroceryAdd ------------------------------------------------

export const previewGroceryAdd = createServerFn({ method: "POST" })
  .validator((data: unknown) => previewInput.parse(data))
  .handler(async ({ data }): Promise<GroceryPreview> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return buildGroceryPreview(getDb(), did, householdId, data);
  });

/**
 * The body of `previewGroceryAdd`. **Writes nothing** — this is the confirm step
 * D9 requires before anything lands on a real list.
 */
export async function buildGroceryPreview(
  db: Kysely<DB>,
  _did: string,
  householdId: string,
  input: { recipes?: Array<{ recipeId: string; scale?: number }>; planWeek?: PlanDate },
): Promise<GroceryPreview> {
  const { loadLexicon } = await import("#/lib/grocery/categorize");
  const { mergeRecipeLines } = await import("#/lib/grocery/merge");

  // A plan week contributes its recipes at 1×; explicit entries may carry their
  // own scale and win when the same recipe appears both ways.
  const fromWeek = input.planWeek ? await planWeekRecipeIds(db, householdId, input.planWeek) : [];
  const scaleById = new Map<string, number>();
  for (const id of fromWeek) scaleById.set(id, 1);
  for (const entry of input.recipes ?? []) scaleById.set(entry.recipeId, entry.scale ?? 1);

  const recipeIds = [...scaleById.keys()];
  if (!recipeIds.length) return { rows: [], recipes: [] };
  if (recipeIds.length > RECIPE_LIMIT) throw new Error("That is too many recipes for one add.");

  const [titles, ingredients, lexicon] = await Promise.all([assertBoxed(db, householdId, recipeIds), ingredientsFor(db, recipeIds), loadLexicon()]);

  const merged = mergeRecipeLines(
    lexicon,
    recipeIds.map((id) => ({ recipeId: id, scale: scaleById.get(id) ?? 1, lines: ingredients.get(id) ?? [] })),
  );

  // What is already on the live list, so the dialog can say "this will merge
  // into the 1 lb you already have" instead of silently doing it.
  const live = await readLiveIdentities(db, householdId);

  const rows: GroceryPreviewRow[] = merged
    // Ignored foods (water, ice) are dropped from a recipe-derived preview
    // outright rather than shown unchecked — nobody shops for tap water.
    .filter((row) => !row.isIgnored)
    .map((row) => ({
      key: identityOf(row),
      foodSlug: row.foodSlug,
      nameNorm: row.nameNorm,
      displayName: row.displayName,
      aisle: row.aisle,
      quantity: row.quantityBase,
      quantityMax: row.quantityMaxBase,
      quantityDisplay: row.quantityDisplay,
      unit: row.unit,
      unitDim: row.unitDim,
      mergeUnit: row.mergeUnit,
      isStaple: row.isStaple,
      mergesInto: live.get(identityOf(row)) ?? null,
      sources: row.sources.map((source) => ({
        recipeId: source.recipeId,
        rawText: source.rawText,
        scale: source.scale,
        quantityBase: source.quantityBase,
      })),
    }));

  return {
    rows,
    recipes: recipeIds.map((id) => ({ recipeId: id, title: titles.get(id) ?? "Untitled", scale: scaleById.get(id) ?? 1 })),
  };
}

/** Identity → item id, for the live rows of a household's list. */
async function readLiveIdentities(db: Kysely<DB>, householdId: string): Promise<Map<string, string>> {
  const rows = await db
    .selectFrom("grocery_item")
    .select(["id", "food_slug", "name_norm", "unit_dim", "merge_unit"])
    .where("household_id", "=", householdId)
    .where("checked_at", "is", null)
    .execute();

  return new Map(rows.map((row) => [identityOf({ foodSlug: row.food_slug, nameNorm: row.name_norm, unitDim: row.unit_dim, mergeUnit: row.merge_unit }), row.id]));
}

// --- §7 commitGroceryAdd -------------------------------------------------

export const commitGroceryAdd = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ rows: z.array(commitRowInput).min(1).max(ROW_LIMIT) }).parse(data))
  .handler(async ({ data }): Promise<{ added: number; merged: number }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return commitGroceryRows(getDb(), did, householdId, data);
  });

type CommitRow = z.infer<typeof commitRowInput>;

/**
 * The body of `commitGroceryAdd`: upsert against the live list, creating it if
 * absent, and append a `grocery_item_source` row per contribution.
 *
 * The rows arrive from a preview the server itself computed, possibly with the
 * user's inline edits to quantity and name applied. They are re-validated for
 * shape and bounds rather than recomputed: the only thing a client can corrupt
 * this way is its own household's list, and re-deriving would throw away the
 * edits D9 exists to allow.
 */
export async function commitGroceryRows(db: Kysely<DB>, did: string, householdId: string, input: { rows: CommitRow[] }): Promise<{ added: number; merged: number }> {
  const { ulid } = await import("./household/ids");
  const { sql } = await import("kysely");

  return db.transaction().execute(async (trx) => {
    const listId = await ensureList(trx, householdId);

    // One read of the live rows, then every row in this commit decides against
    // it — a merge target found here is guaranteed live for the transaction.
    const liveRows = await trx
      .selectFrom("grocery_item")
      .select(["id", "food_slug", "name_norm", "unit_dim", "merge_unit", "quantity", "quantity_max", "unit"])
      .where("household_id", "=", householdId)
      .where("list_id", "=", listId)
      .where("checked_at", "is", null)
      .forUpdate()
      .execute();

    const byIdentity = new Map(liveRows.map((row) => [identityOf({ foodSlug: row.food_slug, nameNorm: row.name_norm, unitDim: row.unit_dim, mergeUnit: row.merge_unit }), row]));

    let added = 0;
    let merged = 0;

    for (const row of input.rows) {
      const identity = identityOf(row);
      const target = byIdentity.get(identity);

      if (target) {
        // Merge into the live row. The existing `unit` anchor is kept so a list
        // built in pounds keeps reading in pounds.
        const nextQuantity = row.quantity == null ? toNum(target.quantity) : (toNum(target.quantity) ?? 0) + row.quantity;
        const nextMax =
          row.quantityMax == null && target.quantity_max == null ? null : (toNum(target.quantity_max) ?? toNum(target.quantity) ?? 0) + (row.quantityMax ?? row.quantity ?? 0);

        await trx
          .updateTable("grocery_item")
          .set({ quantity: nextQuantity, quantity_max: nextMax, updated_at: sql`now()` })
          .where("id", "=", target.id)
          .where("household_id", "=", householdId)
          .execute();

        await insertSources(trx, target.id, did, row);
        merged += 1;
        continue;
      }

      const id = ulid();
      await trx
        .insertInto("grocery_item")
        .values({
          id,
          household_id: householdId,
          list_id: listId,
          food_slug: row.foodSlug,
          name_norm: row.nameNorm,
          display_name: row.displayName,
          aisle: row.aisle,
          quantity: row.quantity,
          quantity_max: row.quantityMax,
          unit: row.unit,
          unit_dim: row.unitDim,
          merge_unit: row.mergeUnit,
          is_manual: false,
          created_by_did: did,
        })
        .execute();

      await insertSources(trx, id, did, row);
      // Later rows in the same commit must be able to merge into this one.
      byIdentity.set(identity, {
        id,
        food_slug: row.foodSlug,
        name_norm: row.nameNorm,
        unit_dim: row.unitDim,
        merge_unit: row.mergeUnit,
        quantity: row.quantity == null ? null : String(row.quantity),
        quantity_max: row.quantityMax == null ? null : String(row.quantityMax),
        unit: row.unit,
      });
      added += 1;
    }

    await touchList(trx, listId, householdId);
    return { added, merged };
  });
}

async function insertSources(db: Kysely<DB>, itemId: string, did: string, row: CommitRow): Promise<void> {
  const { ulid } = await import("./household/ids");
  await db
    .insertInto("grocery_item_source")
    .values(
      row.sources.map((source) => ({
        id: ulid(),
        item_id: itemId,
        recipe_id: source.recipeId,
        plan_entry_id: source.planEntryId ?? null,
        scale: source.scale,
        raw_text: source.rawText,
        quantity_base: source.quantityBase,
        added_by_did: did,
      })),
    )
    .execute();
}

/**
 * The household's one live list, created on first use (plan D1). Racing adds
 * both try to insert; the unique index on `household_id` makes the loser's
 * insert a no-op and it re-reads the winner's row.
 */
async function ensureList(db: Kysely<DB>, householdId: string): Promise<string> {
  const { ulid } = await import("./household/ids");

  const existing = await db.selectFrom("grocery_list").select("id").where("household_id", "=", householdId).executeTakeFirst();
  if (existing) return existing.id;

  const id = ulid();
  const inserted = await db
    .insertInto("grocery_list")
    .values({ id, household_id: householdId })
    .onConflict((oc) => oc.column("household_id").doNothing())
    .returning("id")
    .executeTakeFirst();
  if (inserted) return inserted.id;

  const raced = await db.selectFrom("grocery_list").select("id").where("household_id", "=", householdId).executeTakeFirstOrThrow();
  return raced.id;
}

async function touchList(db: Kysely<DB>, listId: string, householdId: string): Promise<void> {
  const { sql } = await import("kysely");
  await db
    .updateTable("grocery_list")
    .set({ updated_at: sql`now()` })
    .where("id", "=", listId)
    .where("household_id", "=", householdId)
    .execute();
}

// --- §7 addManualGroceryItem ---------------------------------------------

export const addManualGroceryItem = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ text: z.string().trim().min(1).max(200) }).parse(data))
  .handler(async ({ data }): Promise<{ itemId: string; merged: boolean }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return addManualItem(getDb(), did, householdId, data);
  });

/**
 * The body of `addManualGroceryItem`. No preview step (plan §7): typing a line
 * is already the confirmation, so this parses, categorizes and commits in one
 * call. `is_manual` is set so the UI can tell a typed line from a recipe's.
 */
export async function addManualItem(db: Kysely<DB>, did: string, householdId: string, input: { text: string }): Promise<{ itemId: string; merged: boolean }> {
  const { loadLexicon } = await import("#/lib/grocery/categorize");
  const { mergeManualItem } = await import("#/lib/grocery/merge");

  const lexicon = await loadLexicon();
  const row: MergedRow | null = mergeManualItem(lexicon, input.text);
  if (!row) throw new Error("Type what you need to buy.");

  const result = await commitGroceryRows(db, did, householdId, {
    rows: [
      {
        foodSlug: row.foodSlug,
        nameNorm: row.nameNorm,
        displayName: row.displayName,
        aisle: row.aisle,
        quantity: row.quantityBase,
        quantityMax: row.quantityMaxBase,
        unit: row.unit,
        unitDim: row.unitDim,
        mergeUnit: row.mergeUnit,
        sources: row.sources.map((source) => ({
          recipeId: null,
          planEntryId: null,
          rawText: source.rawText,
          scale: source.scale,
          quantityBase: source.quantityBase,
        })),
      },
    ],
  });

  // Mark it manual after the fact: `commitGroceryRows` is the one place that
  // knows how to merge, and duplicating that here to set one boolean would be
  // the worse trade.
  const item = await db
    .selectFrom("grocery_item")
    .select("id")
    .where("household_id", "=", householdId)
    .where("checked_at", "is", null)
    .where("name_norm", "=", row.nameNorm)
    .orderBy("updated_at", "desc")
    .executeTakeFirstOrThrow();

  if (result.added) {
    await db.updateTable("grocery_item").set({ is_manual: true }).where("id", "=", item.id).where("household_id", "=", householdId).execute();
  }

  return { itemId: item.id, merged: result.merged > 0 };
}

// --- §7 getGroceryList ---------------------------------------------------

export const getGroceryList = createServerFn({ method: "GET" }).handler(async (): Promise<GroceryListPayload> => {
  const { getDb } = await import("#/lib/db");
  const { assertMember } = await import("./authz");
  const { did, householdId } = await activeContext();
  await assertMember(did, householdId);
  return readGroceryList(getDb(), did, householdId);
});

/**
 * The body of `getGroceryList`: items in canonical aisle order, each with its
 * source recipes resolved to titles.
 *
 * The default read includes rows checked within the TTL as well as live ones
 * (plan D10). Nothing is deleted and no cron is required — a row simply stops
 * being returned once `checked_at` falls past the window. `readAt` rides along
 * so the client can apply the same cutoff against server time rather than its
 * own clock, which keeps an item checked mid-session visible until reload.
 */
export async function readGroceryList(db: Kysely<DB>, _did: string, householdId: string): Promise<GroceryListPayload> {
  const { sql } = await import("kysely");

  const list = await db.selectFrom("grocery_list").select("id").where("household_id", "=", householdId).executeTakeFirst();
  const readAt = new Date().toISOString();
  if (!list) return { listId: null, items: [], readAt, checkedTtlSeconds: CHECKED_TTL_SECONDS };

  const items = await db
    .selectFrom("grocery_item")
    .select(["id", "food_slug", "display_name", "aisle", "quantity", "quantity_max", "unit", "unit_dim", "is_manual", "checked_at", "checked_by_did", "created_at"])
    .where("household_id", "=", householdId)
    .where("list_id", "=", list.id)
    .where(sql<boolean>`checked_at is null or checked_at > now() - make_interval(secs => ${CHECKED_TTL_SECONDS})`)
    .orderBy("created_at")
    .execute();

  if (!items.length) return { listId: list.id, items: [], readAt, checkedTtlSeconds: CHECKED_TTL_SECONDS };

  const [sources, handles] = await Promise.all([
    db
      .selectFrom("grocery_item_source as s")
      .leftJoin("recipe as r", "r.id", "s.recipe_id")
      .select(["s.item_id as item_id", "s.recipe_id as recipe_id", "s.raw_text as raw_text", "s.scale as scale", "r.name as title"])
      .where(
        "s.item_id",
        "in",
        items.map((item) => item.id),
      )
      .orderBy("s.added_at")
      .execute(),
    resolveHandles(
      db,
      items.map((item) => item.checked_by_did),
    ),
  ]);

  const byItem = new Map<string, GroceryItemSourceRow[]>();
  for (const source of sources) {
    const bucket = byItem.get(source.item_id) ?? [];
    bucket.push({ recipeId: source.recipe_id, title: source.title, rawText: source.raw_text, scale: toNum(source.scale) ?? 1 });
    byItem.set(source.item_id, bucket);
  }

  const rows: GroceryItemRow[] = items.map((item) => {
    const aisleValue = toAisle(item.aisle);
    return {
      id: item.id,
      foodSlug: item.food_slug,
      displayName: item.display_name,
      aisle: aisleValue,
      quantityDisplay: renderTotal(toNum(item.quantity), toNum(item.quantity_max), item.unit_dim, item.unit),
      quantity: toNum(item.quantity),
      unit: item.unit,
      unitDim: item.unit_dim,
      isManual: item.is_manual,
      checkedAt: item.checked_at ? new Date(item.checked_at).toISOString() : null,
      checkedByHandle: item.checked_by_did ? (handles.get(item.checked_by_did) ?? null) : null,
      sources: byItem.get(item.id) ?? [],
    };
  });

  // Canonical aisle order, then insertion order inside an aisle. Sorting here
  // rather than in SQL keeps `aisles.ts` the single source of that order.
  rows.sort((a, b) => aisleOrder(a.aisle) - aisleOrder(b.aisle));

  return { listId: list.id, items: rows, readAt, checkedTtlSeconds: CHECKED_TTL_SECONDS };
}

/**
 * Render a stored total back into store-legible text. An unrecognised `unit_dim`
 * falls back to `count` rather than throwing — a CHECK constraint already
 * guarantees the column, and a list that renders is worth more than one that is
 * right about its own schema.
 */
function renderTotal(quantity: number | null, quantityMax: number | null, unitDim: string | null, unit: string | null): string | null {
  if (quantity == null) return null;
  const dim = unitDim === "volume" || unitDim === "mass" ? unitDim : "count";
  const low = renderQuantity(quantity, dim, unit);
  if (quantityMax == null || Math.abs(quantityMax - quantity) < 1e-9) return low;
  return `${low} – ${renderQuantity(quantityMax, dim, unit)}`;
}

// --- §7 toggle / update / remove -----------------------------------------

export const toggleGroceryItem = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ itemId, checked: z.boolean() }).parse(data))
  .handler(async ({ data }): Promise<{ checkedAt: string | null }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return setGroceryItemChecked(getDb(), did, householdId, data);
  });

/**
 * The body of `toggleGroceryItem`.
 *
 * Unchecking can fail, and legitimately: the live unique index only covers
 * unchecked rows, so if the same food was re-added after this row was checked
 * off (D11), restoring it would collide with that newer row. The error says so
 * rather than surfacing a constraint name.
 */
export async function setGroceryItemChecked(db: Kysely<DB>, did: string, householdId: string, input: { itemId: string; checked: boolean }): Promise<{ checkedAt: string | null }> {
  const { sql } = await import("kysely");

  try {
    const updated = await db
      .updateTable("grocery_item")
      .set({
        checked_at: input.checked ? sql`now()` : null,
        checked_by_did: input.checked ? did : null,
        updated_at: sql`now()`,
      })
      .where("id", "=", input.itemId)
      .where("household_id", "=", householdId)
      .returning("checked_at")
      .executeTakeFirst();

    if (!updated) throw new Error("That item is no longer on the list.");
    return { checkedAt: updated.checked_at ? new Date(updated.checked_at).toISOString() : null };
  } catch (error) {
    if (error instanceof Error && "constraint" in error && error.constraint === "grocery_item_live_identity_key") {
      throw new Error("That is already back on the list — this one stays checked off.", { cause: error });
    }
    throw error;
  }
}

export const updateGroceryItem = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z
      .object({
        itemId,
        displayName: displayName.optional(),
        quantity: quantity.optional(),
        unit: z.string().trim().max(40).nullable().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<{ updated: boolean }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return editGroceryItem(getDb(), did, householdId, data);
  });

/**
 * The body of `updateGroceryItem`. Editing the display name deliberately does
 * NOT move the row's identity: `name_norm` and `food_slug` are what decide
 * merging, and renaming "scallions" to "green onions for the soup" must not
 * split it away from the row it already belongs to.
 */
export async function editGroceryItem(
  db: Kysely<DB>,
  _did: string,
  householdId: string,
  input: { itemId: string; displayName?: string; quantity?: number | null; unit?: string | null },
): Promise<{ updated: boolean }> {
  const { sql } = await import("kysely");

  const patch: Record<string, unknown> = { updated_at: sql`now()` };
  if (input.displayName !== undefined) patch.display_name = input.displayName;
  if (input.quantity !== undefined) {
    patch.quantity = input.quantity;
    // An edited total replaces the range rather than keeping a stale upper bound.
    patch.quantity_max = null;
  }
  if (input.unit !== undefined) patch.unit = input.unit || null;

  const updated = await db.updateTable("grocery_item").set(patch).where("id", "=", input.itemId).where("household_id", "=", householdId).returning("id").executeTakeFirst();

  if (!updated) throw new Error("That item is no longer on the list.");
  return { updated: true };
}

export const removeGroceryItem = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ itemId }).parse(data))
  .handler(async ({ data }): Promise<{ removed: boolean }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return deleteGroceryItem(getDb(), did, householdId, data);
  });

/**
 * The body of `removeGroceryItem`. A real delete, not a soft one: "remove" here
 * means "I did not want this", which is different from "I bought it" (that is
 * `checked_at`) and leaves nothing worth keeping. The source rows cascade.
 */
export async function deleteGroceryItem(db: Kysely<DB>, _did: string, householdId: string, input: { itemId: string }): Promise<{ removed: boolean }> {
  const deleted = await db.deleteFrom("grocery_item").where("id", "=", input.itemId).where("household_id", "=", householdId).returning("id").executeTakeFirst();

  return { removed: Boolean(deleted) };
}

/** Clear every checked row from the list at once — the end-of-trip sweep. */
export const clearCheckedGroceryItems = createServerFn({ method: "POST" }).handler(async (): Promise<{ removed: number }> => {
  const { getDb } = await import("#/lib/db");
  const { assertMember } = await import("./authz");
  const { did, householdId } = await activeContext();
  await assertMember(did, householdId);
  return clearCheckedItems(getDb(), did, householdId);
});

/** The body of `clearCheckedGroceryItems`. */
export async function clearCheckedItems(db: Kysely<DB>, _did: string, householdId: string): Promise<{ removed: number }> {
  const deleted = await db.deleteFrom("grocery_item").where("household_id", "=", householdId).where("checked_at", "is not", null).returning("id").execute();

  return { removed: deleted.length };
}
