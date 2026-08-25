import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "./session";
import { toJsonRow, toJsonValue, type JsonValue } from "./json";

/**
 * The LOCAL side of the story: `public.recipe` and its child tables, read raw.
 *
 * Two shapes come out of here and they serve different questions:
 *
 * - `LocalRecipeTables` — the rows exactly as stored. This is what an operator
 *   opens when the question is "what is actually in Postgres".
 * - `projection` — those same rows re-expressed as `exchange.recipe.recipe`
 *   paths (`name`, `ingredients.0`, `nutrition.calories`, …) so the detail view
 *   can line the local copy up against the network record field by field. The
 *   projection is a VIEW of the local rows, never a substitute for them: when
 *   the two disagree the tables are the evidence.
 *
 * `getDb()` is imported dynamically inside each handler so `pg` stays out of the
 * client bundle.
 */

const recipeId = z.string().min(1).max(512);

/** A `public.recipe` row plus its children, untouched. */
export interface LocalRecipeTables {
  recipe: Record<string, JsonValue>;
  ingredients: Array<{ ordinal: number; text: string }>;
  instructions: Array<{ ordinal: number; text: string }>;
  images: Array<Record<string, JsonValue>>;
  keywords: string[];
  attribution: Record<string, JsonValue> | null;
  meta: Array<{ ns: string; key: string; value: JsonValue; updated_at: string }>;
  /** Households that have this recipe in their box, and when they filed it. */
  boxes: Array<{ household_id: string; household_name: string | null; added_at: string; favorite: boolean }>;
}

export interface LocalRecipeDetail {
  tables: LocalRecipeTables;
  /** `exchange.recipe.recipe` paths → rendered values. See `lib/record-shape.ts`. */
  projection: Record<string, string>;
}

/**
 * Render a stored scalar the same way `flattenRecord` renders a wire scalar —
 * the two have to agree, or the comparison reports differences that are only
 * formatting. Inputs here have been through `toJsonRow`, so a container is JSON
 * rather than `[object Object]`.
 */
function render(value: JsonValue): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function put(into: Record<string, string>, path: string, value: JsonValue | undefined): void {
  if (value === undefined) return;
  const rendered = render(value);
  if (rendered !== null) into[path] = rendered;
}

/**
 * Map the relational local copy onto lexicon paths. The column→field names are
 * the ones `services/web/src/lib/recipe-record.ts` publishes with — notably
 * `recipe.description` is the record's `text`, which is the single most
 * confusing pair in the schema and the reason this function exists in one place.
 */
export function projectLocalRecipe(tables: LocalRecipeTables): Record<string, string> {
  const out: Record<string, string> = {};
  const r = tables.recipe;

  put(out, "name", r.name);
  put(out, "text", r.description);
  put(out, "createdAt", r.record_created_at);
  put(out, "updatedAt", r.record_updated_at);
  put(out, "prepTime", r.prep_time);
  put(out, "cookTime", r.cook_time);
  put(out, "totalTime", r.total_time);
  put(out, "recipeYield", r.recipe_yield);
  put(out, "recipeCategory", r.recipe_category);
  put(out, "recipeCuisine", r.recipe_cuisine);
  put(out, "cookingMethod", r.cooking_method);
  put(out, "nutrition.calories", r.calories);
  put(out, "nutrition.fatContent", r.fat_content);
  put(out, "nutrition.proteinContent", r.protein_content);
  put(out, "nutrition.carbohydrateContent", r.carbohydrate_content);

  // Ordinals are the published order and are dense from 0, but this reads the
  // stored ordinal rather than the array index so a gap shows up as a gap
  // instead of silently renumbering itself in the comparison.
  for (const row of tables.ingredients) put(out, `ingredients.${row.ordinal}`, row.text);
  for (const row of tables.instructions) put(out, `instructions.${row.ordinal}`, row.text);

  const diets = Array.isArray(r.suitable_for_diet) ? (r.suitable_for_diet as string[]) : [];
  diets.forEach((diet, index) => put(out, `suitableForDiet.${index}`, diet));
  tables.keywords.forEach((keyword, index) => put(out, `keywords.${index}`, keyword));

  tables.images.forEach((image) => {
    const ordinal = Number(image.ordinal ?? 0);
    put(out, `embed.images.${ordinal}.alt`, image.alt);
    // The record carries the blob as `{$type: "blob", ref: {$link: <cid>}, …}`;
    // `flattenRecord` renders that link at `…image.ref.$link`, so the local side
    // has to use the identical path or the two never line up.
    put(out, `embed.images.${ordinal}.image.ref.$link`, image.blob_cid);
    put(out, `embed.images.${ordinal}.image.mimeType`, image.blob_mime);
    put(out, `embed.images.${ordinal}.image.size`, image.blob_size);
    put(out, `embed.images.${ordinal}.aspectRatio.width`, image.aspect_w);
    put(out, `embed.images.${ordinal}.aspectRatio.height`, image.aspect_h);
  });

  return out;
}

/** Load one local recipe and everything hanging off it. Null when unknown. */
export async function loadLocalRecipe(id: string): Promise<LocalRecipeDetail | null> {
  const { getDb } = await import("#/lib/db");
  const db = getDb();

  const recipe = await db.selectFrom("recipe").selectAll().where("id", "=", id).executeTakeFirst();
  if (!recipe) return null;

  const [ingredients, instructions, images, keywords, attribution, meta, boxes] = await Promise.all([
    db.selectFrom("recipe_ingredient").select(["ordinal", "text"]).where("recipe_id", "=", id).orderBy("ordinal").execute(),
    db.selectFrom("recipe_instruction").select(["ordinal", "text"]).where("recipe_id", "=", id).orderBy("ordinal").execute(),
    db.selectFrom("recipe_image").selectAll().where("recipe_id", "=", id).orderBy("ordinal").execute(),
    db.selectFrom("recipe_keyword").select(["keyword"]).where("recipe_id", "=", id).orderBy("keyword").execute(),
    db.selectFrom("recipe_attribution").selectAll().where("recipe_id", "=", id).executeTakeFirst(),
    db.selectFrom("recipe_meta").select(["ns", "key", "value", "updated_at"]).where("recipe_id", "=", id).orderBy("ns").orderBy("key").execute(),
    db
      .selectFrom("household_recipe as hr")
      .leftJoin("household as h", "h.id", "hr.household_id")
      .select(["hr.household_id", "h.name as household_name", "hr.added_at", "hr.favorite"])
      .where("hr.recipe_id", "=", id)
      .orderBy("hr.added_at", "desc")
      .execute(),
  ]);

  const tables: LocalRecipeTables = {
    recipe: toJsonRow(recipe),
    ingredients,
    instructions,
    images: images.map(toJsonRow),
    keywords: keywords.map((row) => row.keyword),
    attribution: attribution ? toJsonRow(attribution) : null,
    meta: meta.map((row) => ({ ns: row.ns, key: row.key, value: toJsonValue(row.value), updated_at: new Date(row.updated_at).toISOString() })),
    boxes: boxes.map((row) => ({
      household_id: row.household_id,
      household_name: row.household_name,
      added_at: new Date(row.added_at).toISOString(),
      favorite: row.favorite,
    })),
  };

  return { tables, projection: projectLocalRecipe(tables) };
}

/** The local recipe published as `(did, rkey)`, if there is one. */
export async function loadLocalRecipeByRecord(did: string, rkey: string): Promise<LocalRecipeDetail | null> {
  const { getDb } = await import("#/lib/db");
  const row = await getDb().selectFrom("recipe").select(["id"]).where("did", "=", did).where("rkey", "=", rkey).executeTakeFirst();
  return row ? loadLocalRecipe(row.id) : null;
}

/** One row of the local recipe browser. */
export interface LocalRecipeRow {
  id: string;
  name: string;
  origin: string;
  visibility: string;
  did: string | null;
  rkey: string | null;
  cid: string | null;
  published_at: string | null;
  record_updated_at: string | null;
  indexed_at: string;
  /** Whether the sync index also carries this record — the two-sided case. */
  on_network: boolean;
  box_count: number;
}

export const listLocalRecipes = createServerFn({ method: "GET" })
  .validator((data: unknown) =>
    z
      .object({
        search: z.string().max(200).optional(),
        origin: z.string().max(50).optional(),
        // `published` = has a did+rkey; `local` = has neither.
        state: z.enum(["all", "published", "local"]).default("all"),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      })
      .parse(data ?? {}),
  )
  .handler(async ({ data }): Promise<{ rows: LocalRecipeRow[]; total: number }> => {
    await requireAdmin();
    const { getDb } = await import("#/lib/db");
    const db = getDb();

    // One filtered builder, two selects, so the "N of M" in the footer can never
    // disagree with the rows above it. The join is on the base and shared by the
    // count: `atproto_collection_recipe`'s primary key is `(did, rkey)`, so it
    // matches at most one row per recipe and cannot inflate the total.
    let filtered = db.selectFrom("recipe as r").leftJoin("atproto_collection_recipe as acr", (join) => join.onRef("acr.did", "=", "r.did").onRef("acr.rkey", "=", "r.rkey"));

    if (data.search) filtered = filtered.where("r.name", "ilike", `%${data.search}%`);
    if (data.origin) filtered = filtered.where("r.origin", "=", data.origin);
    if (data.state === "published") filtered = filtered.where("r.rkey", "is not", null);
    if (data.state === "local") filtered = filtered.where("r.rkey", "is", null);

    const rows = await filtered
      .select((eb) => [
        "r.id",
        "r.name",
        "r.origin",
        "r.visibility",
        "r.did",
        "r.rkey",
        "r.cid",
        "r.published_at",
        "r.record_updated_at",
        "r.indexed_at",
        "acr.uri as network_uri",
        eb
          .selectFrom("household_recipe as hr")
          .whereRef("hr.recipe_id", "=", "r.id")
          .select((inner) => inner.fn.countAll<string>().as("count"))
          .as("box_count"),
      ])
      .orderBy("r.indexed_at", "desc")
      .limit(data.limit)
      .offset(data.offset)
      .execute();

    const counted = await filtered.select((eb) => eb.fn.countAll<string>().as("total")).executeTakeFirst();

    return {
      rows: rows.map((row) => ({
        id: row.id,
        name: row.name,
        origin: row.origin,
        visibility: row.visibility,
        did: row.did,
        rkey: row.rkey,
        cid: row.cid,
        published_at: row.published_at ? new Date(row.published_at).toISOString() : null,
        record_updated_at: row.record_updated_at ? new Date(row.record_updated_at).toISOString() : null,
        indexed_at: new Date(row.indexed_at).toISOString(),
        on_network: row.network_uri !== null,
        box_count: Number(row.box_count ?? 0),
      })),
      total: Number(counted?.total ?? 0),
    };
  });

export const getLocalRecipe = createServerFn({ method: "GET" })
  .validator((data: unknown) => z.object({ id: recipeId }).parse(data))
  .handler(async ({ data }): Promise<LocalRecipeDetail | null> => {
    await requireAdmin();
    return loadLocalRecipe(data.id);
  });
