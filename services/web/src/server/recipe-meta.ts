import { sql, type Kysely } from "kysely";
import type { DB } from "#/db/types";
import type { JsonObject, JsonValue } from "@buttery/recipe-extract/import";

/**
 * Access helpers for Buttery's two namespaced key/value sidecar tables —
 * `recipe_meta` (global, about the recipe itself) and `household_recipe_meta`
 * (per household+recipe). See `docs/plans/2026-08-09-paprika-import.md` §5.4.
 *
 * Server-only, and deliberately thin: these wrap a `select`/`insert … on
 * conflict do update` and nothing else. No namespace is interpreted here — a
 * caller that wants to know what `ns='dedupe'` or `ns='import'` means owns that
 * knowledge (§5.1/§5.2 name the keys).
 *
 * ── NEVER PUBLISHED (§2.3) ────────────────────────────────────────────────
 * `recipe_meta` and `household_recipe_meta` are read by Buttery and by NOTHING
 * ELSE. Nothing in `lib/atproto/recipe-writes` or the `atproto-sync` workflow
 * may read them, and no value in either table may ever appear in an
 * `exchange.recipe.recipe` record. The sidecar is where facts live that are
 * true for us and are nobody else's business — a source URL key, a content
 * fingerprint, which import session dropped a recipe into this box. This is a
 * review rule; a test asserts the published record shape is unchanged by the
 * presence of sidecar rows.
 *
 * ── KEY/VALUE IS A VELOCITY CHOICE (§5.5) ─────────────────────────────────
 * `jsonb` values and no type safety were chosen to move fast. A namespace that
 * proves durable is expected to graduate to typed columns or its own table.
 */

/**
 * A Kysely instance or an open transaction. `Transaction<DB>` extends
 * `Kysely<DB>`, so this one type accepts both and every helper below can be
 * called inside a caller's transaction — which is how `persistRecipeDraft`
 * writes a recipe's dedupe keys in the same transaction as the recipe itself
 * (§6.6), so a recipe never exists without its keys.
 */
export type MetaDb = Kysely<DB>;

/** One (recipe, entries) write for the batch helpers. */
export interface RecipeMetaRow {
  recipeId: string;
  ns: string;
  entries: JsonObject;
}

/** `updated_at` is refreshed on every upsert; the insert default only covers the first write. */
const touched = sql<Date>`now()`;

/** Rows come back with `value` already parsed by the pg driver. */
function collect(rows: readonly { key: string; value: unknown }[]): JsonObject {
  const out: JsonObject = {};
  for (const row of rows) out[row.key] = row.value as JsonValue;
  return out;
}

/**
 * jsonb goes in as a serialized string — the repo's existing convention for
 * jsonb columns (`recipe_attribution.raw`, `recipe_import_attempt.parsed`) and
 * the only form the pg driver can distinguish from a composite/array literal.
 */
function serialize(value: JsonValue): string {
  return JSON.stringify(value ?? null);
}

// --- recipe_meta (global) ------------------------------------------------

/** Every key in one namespace for a recipe, as `{ key: value }`. Empty object when there are none. */
export async function getRecipeMeta(db: MetaDb, recipeId: string, ns: string): Promise<JsonObject> {
  const rows = await db.selectFrom("recipe_meta").select(["key", "value"]).where("recipe_id", "=", recipeId).where("ns", "=", ns).execute();
  return collect(rows);
}

/** Upsert every entry into one namespace. Keys absent from `entries` are left alone — this is not a replace. */
export async function setRecipeMeta(db: MetaDb, recipeId: string, ns: string, entries: JsonObject): Promise<void> {
  await setManyRecipeMeta(db, [{ recipeId, ns, entries }]);
}

/**
 * Upsert many (recipe, ns, key) entries in ONE statement. Same reason as
 * {@link setManyHouseholdRecipeMeta}: a per-key round trip turns a chunk commit
 * into hundreds of statements.
 */
export async function setManyRecipeMeta(db: MetaDb, rows: readonly RecipeMetaRow[]): Promise<void> {
  const values = rows.flatMap((row) =>
    Object.entries(row.entries).map(([key, value]) => ({
      recipe_id: row.recipeId,
      ns: row.ns,
      key,
      value: serialize(value),
    })),
  );
  if (!values.length) return;
  await db
    .insertInto("recipe_meta")
    .values(values)
    .onConflict((oc) => oc.columns(["recipe_id", "ns", "key"]).doUpdateSet({ value: sql`excluded.value`, updated_at: touched }))
    .execute();
}

// --- household_recipe_meta (per household+recipe) ------------------------

/** Every key in one namespace for a (household, recipe) pair, as `{ key: value }`. */
export async function getHouseholdRecipeMeta(db: MetaDb, householdId: string, recipeId: string, ns: string): Promise<JsonObject> {
  const rows = await db
    .selectFrom("household_recipe_meta")
    .select(["key", "value"])
    .where("household_id", "=", householdId)
    .where("recipe_id", "=", recipeId)
    .where("ns", "=", ns)
    .execute();
  return collect(rows);
}

/** Upsert every entry into one namespace for a (household, recipe) pair. */
export async function setHouseholdRecipeMeta(db: MetaDb, householdId: string, recipeId: string, ns: string, entries: JsonObject): Promise<void> {
  await setManyHouseholdRecipeMeta(db, householdId, [{ recipeId, ns, entries }]);
}

/**
 * Upsert many (recipe, ns, key) entries for one household in ONE statement.
 *
 * Load-bearing, not a convenience: the commit path writes ~6 keys for each of
 * 25 recipes per chunk (§12.5), so the per-key form would be 150 round trips
 * inside a transaction that is already holding the chunk's row locks.
 */
export async function setManyHouseholdRecipeMeta(db: MetaDb, householdId: string, rows: readonly RecipeMetaRow[]): Promise<void> {
  const values = rows.flatMap((row) =>
    Object.entries(row.entries).map(([key, value]) => ({
      household_id: householdId,
      recipe_id: row.recipeId,
      ns: row.ns,
      key,
      value: serialize(value),
    })),
  );
  if (!values.length) return;
  await db
    .insertInto("household_recipe_meta")
    .values(values)
    .onConflict((oc) => oc.columns(["household_id", "recipe_id", "ns", "key"]).doUpdateSet({ value: sql`excluded.value`, updated_at: touched }))
    .execute();
}
