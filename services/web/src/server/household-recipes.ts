import { createServerFn } from "@tanstack/react-start";
import { blobImageUrl } from "#/lib/atproto/images";
import { type RecipeSource, deriveSource, prettify } from "./recipe-provenance";

/**
 * The household "recipe box" server functions (plan §6). Every one resolves the
 * caller DID from the server-validated session, the active household from
 * `session.active_household_id` (NEVER a client argument), and gates through
 * `assertMember` and/or `householdScopedQuery` — the membership join IS the
 * authorization, so there is no code path that returns a row for a non-member.
 *
 * Server-only: `getDb`, kysely `sql`, and the authz/session helpers are pulled
 * in via dynamic `import()` inside each handler so this module stays safe to
 * reference from the client bundle (the pattern the household modules use).
 */

// --- shared shapes ------------------------------------------------------

/** One ledger row (left pane). Filter/sort/search happen client-side over these. */
export interface HouseholdRecipeRow {
  recipeId: string;
  title: string;
  favorite: boolean;
  sourceKind: RecipeSource["kind"];
  sourceLabel: string;
  sourceUrl: string | null;
  /** Total time in whole minutes, or null (sorts last under "Quickest"). */
  totalMinutes: number | null;
  /** Pre-formatted display string for `totalMinutes` ("1h 30m"), or null. */
  totalTimeDisplay: string | null;
  keywords: string[];
  thumbUrl: string | null;
  /** Source went unavailable on the network; still renders from cache. */
  unavailable: boolean;
  /** A local draft/private recipe with no atproto record yet (shows a lock). */
  unpublished: boolean;
}

/** Per-serving nutrition; individual cells are null when the value is absent. */
export interface RecipeNutrition {
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
}

/** The shared private note on a boxed recipe. */
export interface HouseholdRecipeNoteView {
  body: string;
  updatedAt: string;
}

/** Full detail for a boxed recipe (right pane). */
export interface HouseholdRecipeDetail {
  recipeId: string;
  title: string;
  description: string | null;
  source: RecipeSource;
  images: Array<{ url: string; alt: string | null }>;
  ingredients: string[];
  instructions: string[];
  keywords: string[];
  recipeYield: string | null;
  /** Parsed leading integer of `recipeYield`, or null. */
  serves: number | null;
  totalMinutes: number | null;
  totalTimeDisplay: string | null;
  cuisine: string | null;
  category: string | null;
  nutrition: RecipeNutrition;
  favorite: boolean;
  note: HouseholdRecipeNoteView | null;
  /** Best-effort handle of whoever added it to the box ("saved by @handle"). */
  addedByHandle: string | null;
  unavailable: boolean;
  /** ISO timestamp the source went unavailable, when known. */
  unavailableSince: string | null;
  /** A local draft/private recipe with no atproto record yet (publishable). */
  unpublished: boolean;
}

/** One picker result (global public search, excludes already-boxed). */
export interface GlobalRecipeResult {
  recipeId: string;
  title: string;
  description: string | null;
  source: RecipeSource;
  thumbUrl: string | null;
}

// --- helpers ------------------------------------------------------------

/** Recipe-id validator, mirroring `getRecipe`: non-empty, capped, bound as a param. */
function validateRecipeId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0 || id.length > 512) throw new Error("Invalid recipe id");
  return id;
}

/** total_time_seconds → { minutes, display } ("1h 30m" / "45m"), nulls for absent. */
function minutesDisplay(totalSeconds: number | null | undefined): { minutes: number | null; display: string | null } {
  if (!totalSeconds || totalSeconds <= 0) return { minutes: null, display: null };
  const minutes = Math.round(totalSeconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const display = h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  return { minutes, display };
}

/** pg numeric arrives as a string via Kysely; coerce to a finite number or null. */
function toNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve `{ did, householdId }` for a household-scoped handler: the caller DID
 * from the validated session, the active household from the session (never a
 * client argument). Throws `NotAMemberError` when there is no active household
 * (a route loader's `requireActiveHousehold` already redirects such callers, but
 * a bare mutation must still fail closed).
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

// --- §6.1 listHouseholdRecipes ------------------------------------------

/**
 * The whole box in one shot (small N; filter/sort/search are client-side). The
 * `householdScopedQuery` membership join is the authorization gate.
 */
export const listHouseholdRecipes = createServerFn({ method: "GET" }).handler(async (): Promise<HouseholdRecipeRow[]> => {
  const { getDb } = await import("#/lib/db");
  const { householdScopedQuery } = await import("./household/scoped-query");
  const { did, householdId } = await activeContext();
  const db = getDb();

  const rows = await householdScopedQuery(db, did, householdId)
    .innerJoin("household_recipe as hr", "hr.household_id", "hm.household_id")
    .innerJoin("recipe as r", "r.id", "hr.recipe_id")
    .leftJoin("recipe_image as img", (join) => join.onRef("img.recipe_id", "=", "r.id").on("img.ordinal", "=", 0))
    .leftJoin("recipe_attribution as attr", "attr.recipe_id", "r.id")
    .leftJoin("atproto_repo as repo", "repo.did", "r.did")
    .leftJoin("atproto_collection_recipe as acr", (join) => join.onRef("acr.did", "=", "r.did").onRef("acr.rkey", "=", "r.rkey"))
    .select([
      "r.id as id",
      "r.name as name",
      "r.origin as origin",
      "r.did as did",
      "r.visibility as visibility",
      "r.uri as uri",
      "r.total_time_seconds as total_time_seconds",
      "hr.favorite as favorite",
      "hr.added_at as added_at",
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
    .orderBy("hr.added_at", "desc")
    .execute();

  // Keywords in one round-trip, grouped by recipe.
  const ids = rows.map((r) => r.id);
  const keywordsByRecipe = new Map<string, string[]>();
  if (ids.length) {
    const kw = await db.selectFrom("recipe_keyword").select(["recipe_id", "keyword"]).where("recipe_id", "in", ids).execute();
    for (const { recipe_id, keyword } of kw) {
      const list = keywordsByRecipe.get(recipe_id) ?? [];
      list.push(keyword);
      keywordsByRecipe.set(recipe_id, list);
    }
  }

  return rows.map((row): HouseholdRecipeRow => {
    const { minutes, display } = minutesDisplay(row.total_time_seconds);
    const source = deriveSource({
      origin: row.origin,
      id: row.id,
      repoHandle: row.repo_handle,
      attrDisplayName: row.attr_display_name,
      attrAuthor: row.attr_author,
      attrPublisher: row.attr_publisher,
      attrUrl: row.attr_url,
    });
    // origin='local' recipes are Buttery-owned and always available; only synced
    // recipes can lose their network source (raw layer deleted/invalid).
    const unavailable = row.origin === "sync" && (row.acr_deleted_at !== null || row.acr_validation_status == null || row.acr_validation_status !== "valid");
    return {
      recipeId: row.id,
      title: row.name,
      favorite: row.favorite,
      sourceKind: source.kind,
      sourceLabel: source.label,
      sourceUrl: source.url,
      totalMinutes: minutes,
      totalTimeDisplay: display,
      keywords: keywordsByRecipe.get(row.id) ?? [],
      thumbUrl: row.did && row.blob_cid ? blobImageUrl(row.did, row.blob_cid, row.blob_mime, "feed_thumbnail") : null,
      unavailable,
      unpublished: row.visibility !== "public" || row.uri == null,
    };
  });
});

// --- §6.2 getHouseholdRecipe --------------------------------------------

/**
 * Full detail for one boxed recipe. Authorization = box membership, NOT
 * `visibility='public'`: this must render a recipe whose source has since gone
 * unavailable (the whole point of the cache).
 */
export const getHouseholdRecipe = createServerFn({ method: "GET" })
  .validator((data: { recipeId: string }) => ({ recipeId: validateRecipeId(data?.recipeId) }))
  .handler(async ({ data }): Promise<HouseholdRecipeDetail | null> => {
    const { getDb } = await import("#/lib/db");
    const { householdScopedQuery } = await import("./household/scoped-query");
    const { did, householdId } = await activeContext();
    const db = getDb();

    // The box row (scoped by membership) is both the authz gate and the 404:
    // you may only read content for recipes in YOUR box. No visibility filter.
    const boxed = await householdScopedQuery(db, did, householdId)
      .innerJoin("household_recipe as hr", "hr.household_id", "hm.household_id")
      .where("hr.recipe_id", "=", data.recipeId)
      .select(["hr.recipe_id as recipe_id", "hr.favorite as favorite", "hr.added_by_did as added_by_did"])
      .executeTakeFirst();
    if (!boxed) return null;

    const row = await db
      .selectFrom("recipe as r")
      .leftJoin("recipe_attribution as attr", "attr.recipe_id", "r.id")
      .leftJoin("atproto_repo as repo", "repo.did", "r.did")
      .leftJoin("atproto_collection_recipe as acr", (join) => join.onRef("acr.did", "=", "r.did").onRef("acr.rkey", "=", "r.rkey"))
      .where("r.id", "=", data.recipeId)
      .select([
        "r.id as id",
        "r.name as name",
        "r.description as description",
        "r.origin as origin",
        "r.did as did",
        "r.visibility as visibility",
        "r.uri as uri",
        "r.recipe_yield as recipe_yield",
        "r.total_time_seconds as total_time_seconds",
        "r.recipe_cuisine as recipe_cuisine",
        "r.recipe_category as recipe_category",
        "r.calories as calories",
        "r.protein_content as protein_content",
        "r.carbohydrate_content as carbohydrate_content",
        "r.fat_content as fat_content",
        "attr.display_name as attr_display_name",
        "attr.author as attr_author",
        "attr.publisher as attr_publisher",
        "attr.url as attr_url",
        "repo.handle as repo_handle",
        "acr.deleted_at as acr_deleted_at",
        "acr.validation_status as acr_validation_status",
      ])
      .executeTakeFirst();
    if (!row) return null; // RESTRICT FK means this should never happen for a boxed recipe.

    const [images, ingredients, instructions, keywords, note, adder] = await Promise.all([
      db.selectFrom("recipe_image").select(["blob_cid", "blob_mime", "alt"]).where("recipe_id", "=", data.recipeId).orderBy("ordinal").execute(),
      db.selectFrom("recipe_ingredient").select("text").where("recipe_id", "=", data.recipeId).orderBy("ordinal").execute(),
      db.selectFrom("recipe_instruction").select("text").where("recipe_id", "=", data.recipeId).orderBy("ordinal").execute(),
      db.selectFrom("recipe_keyword").select("keyword").where("recipe_id", "=", data.recipeId).execute(),
      db.selectFrom("household_recipe_note").select(["body", "updated_at"]).where("household_id", "=", householdId).where("recipe_id", "=", data.recipeId).executeTakeFirst(),
      db.selectFrom("atproto_repo").select("handle").where("did", "=", boxed.added_by_did).executeTakeFirst(),
    ]);

    const { minutes, display } = minutesDisplay(row.total_time_seconds);
    const source = deriveSource({
      origin: row.origin,
      id: row.id,
      repoHandle: row.repo_handle,
      attrDisplayName: row.attr_display_name,
      attrAuthor: row.attr_author,
      attrPublisher: row.attr_publisher,
      attrUrl: row.attr_url,
    });
    const { parseServes } = await import("#/lib/recipe-scale");
    const unavailable = row.origin === "sync" && (row.acr_deleted_at !== null || row.acr_validation_status == null || row.acr_validation_status !== "valid");

    return {
      recipeId: row.id,
      title: row.name,
      description: row.description,
      source,
      images: images
        .filter((img) => row.did && img.blob_cid)
        .map((img) => ({ url: blobImageUrl(row.did as string, img.blob_cid as string, img.blob_mime, "feed_fullsize"), alt: img.alt })),
      ingredients: ingredients.map((i) => i.text),
      instructions: instructions.map((i) => i.text),
      keywords: keywords.map((k) => k.keyword),
      recipeYield: row.recipe_yield,
      serves: parseServes(row.recipe_yield),
      totalMinutes: minutes,
      totalTimeDisplay: display,
      cuisine: prettify(row.recipe_cuisine),
      category: prettify(row.recipe_category),
      nutrition: {
        calories: toNum(row.calories),
        protein: toNum(row.protein_content),
        carbs: toNum(row.carbohydrate_content),
        fat: toNum(row.fat_content),
      },
      favorite: boxed.favorite,
      note: note ? { body: note.body, updatedAt: new Date(note.updated_at).toISOString() } : null,
      addedByHandle: adder?.handle ? `@${adder.handle}` : null,
      unavailable,
      unavailableSince: row.acr_deleted_at ? new Date(row.acr_deleted_at).toISOString() : null,
      unpublished: row.visibility !== "public" || row.uri == null,
    };
  });

// --- §6.3 addRecipeToHousehold ------------------------------------------

/**
 * Link an existing PUBLIC recipe into the box. Idempotent (`on conflict do
 * nothing`). You can only ADD a currently-public recipe; already-boxed recipes
 * that later go private stay via the cache. Returns the new ledger row (or the
 * existing one if it was already boxed).
 */
export const addRecipeToHousehold = createServerFn({ method: "POST" })
  .validator((data: { recipeId: string }) => ({ recipeId: validateRecipeId(data?.recipeId) }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    const db = getDb();

    const recipe = await db.selectFrom("recipe").select("id").where("id", "=", data.recipeId).where("visibility", "=", "public").executeTakeFirst();
    if (!recipe) throw new Error("Recipe is not available to add.");

    await db
      .insertInto("household_recipe")
      .values({ household_id: householdId, recipe_id: data.recipeId, added_by_did: did })
      .onConflict((oc) => oc.columns(["household_id", "recipe_id"]).doNothing())
      .execute();

    return { ok: true };
  });

// --- §6.4 removeRecipeFromHousehold -------------------------------------

/** Remove a recipe from the box (cascades its shared note). Idempotent. */
export const removeRecipeFromHousehold = createServerFn({ method: "POST" })
  .validator((data: { recipeId: string }) => ({ recipeId: validateRecipeId(data?.recipeId) }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);

    await getDb().deleteFrom("household_recipe").where("household_id", "=", householdId).where("recipe_id", "=", data.recipeId).execute();
    return { ok: true };
  });

// --- §6.5 toggleHouseholdRecipeFavorite ---------------------------------

/** Flip the household-shared favorite flag on a boxed recipe. Returns `{ favorite }`. */
export const toggleHouseholdRecipeFavorite = createServerFn({ method: "POST" })
  .validator((data: { recipeId: string }) => ({ recipeId: validateRecipeId(data?.recipeId) }))
  .handler(async ({ data }): Promise<{ favorite: boolean }> => {
    const { getDb } = await import("#/lib/db");
    const { sql } = await import("kysely");
    const { assertMember } = await import("./authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);

    const updated = await getDb()
      .updateTable("household_recipe")
      .set({
        favorite: sql`not favorite`,
        favorited_at: sql`case when not favorite then now() else null end`,
      })
      .where("household_id", "=", householdId)
      .where("recipe_id", "=", data.recipeId)
      .returning("favorite")
      .executeTakeFirst();

    if (!updated) throw new Error("Recipe is not in this household's box.");
    return { favorite: updated.favorite };
  });

// --- §6.6 upsertHouseholdRecipeNote -------------------------------------

/**
 * Upsert (or, on an empty body, delete) the shared private note. `author_did` is
 * the last editor. Returns the persisted note, or null when it was cleared.
 */
export const upsertHouseholdRecipeNote = createServerFn({ method: "POST" })
  .validator((data: { recipeId: string; body: string }) => {
    const recipeId = validateRecipeId(data?.recipeId);
    const body = typeof data?.body === "string" ? data.body : "";
    if (body.length > 10000) throw new Error("Note is too long.");
    return { recipeId, body };
  })
  .handler(async ({ data }): Promise<HouseholdRecipeNoteView | null> => {
    const { getDb } = await import("#/lib/db");
    const { sql } = await import("kysely");
    const { assertMember } = await import("./authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    const db = getDb();

    // The note references the box row (composite FK); require it to exist so a
    // note can't outlive its recipe or attach to an unboxed one.
    const boxed = await db.selectFrom("household_recipe").select("recipe_id").where("household_id", "=", householdId).where("recipe_id", "=", data.recipeId).executeTakeFirst();
    if (!boxed) throw new Error("Recipe is not in this household's box.");

    const body = data.body.trim();
    if (body === "") {
      await db.deleteFrom("household_recipe_note").where("household_id", "=", householdId).where("recipe_id", "=", data.recipeId).execute();
      return null;
    }

    const saved = await db
      .insertInto("household_recipe_note")
      .values({ household_id: householdId, recipe_id: data.recipeId, author_did: did, body })
      .onConflict((oc) =>
        oc.columns(["household_id", "recipe_id"]).doUpdateSet({
          body,
          author_did: did,
          updated_at: sql`now()`,
        }),
      )
      .returning(["body", "updated_at"])
      .executeTakeFirstOrThrow();

    return { body: saved.body, updatedAt: new Date(saved.updated_at).toISOString() };
  });

// --- §6.7 searchGlobalRecipes -------------------------------------------

/**
 * Public-corpus search for the picker (§5.5). `recipe` where `visibility='public'`,
 * matched via `recipe_search.search_tsv` (with a `name ilike` fallback for short
 * / fuzzy terms), LEFT-ANTI-JOINED against the caller's box so already-added
 * recipes don't appear. Requires an authenticated session; paginated via an
 * opaque numeric-offset cursor.
 */
export const searchGlobalRecipes = createServerFn({ method: "GET" })
  .validator((data: { q?: string; limit?: number; cursor?: string | null }) => ({
    q: typeof data?.q === "string" ? data.q.slice(0, 200) : "",
    limit: Math.min(Math.max(Number(data?.limit) || 20, 1), 50),
    cursor: typeof data?.cursor === "string" && /^\d+$/.test(data.cursor) ? Number(data.cursor) : 0,
  }))
  .handler(async ({ data }): Promise<{ results: GlobalRecipeResult[]; nextCursor: string | null }> => {
    const { getDb } = await import("#/lib/db");
    const { sql } = await import("kysely");
    const { householdId } = await activeContext(); // gate: authenticated + active household
    const db = getDb();

    const q = data.q.trim();
    let query = db
      .selectFrom("recipe as r")
      .leftJoin("recipe_image as img", (join) => join.onRef("img.recipe_id", "=", "r.id").on("img.ordinal", "=", 0))
      .leftJoin("recipe_attribution as attr", "attr.recipe_id", "r.id")
      .leftJoin("atproto_repo as repo", "repo.did", "r.did")
      .where("r.visibility", "=", "public")
      .where((eb) =>
        eb.not(eb.exists(eb.selectFrom("household_recipe as hr").select("hr.recipe_id").whereRef("hr.recipe_id", "=", "r.id").where("hr.household_id", "=", householdId))),
      )
      .select([
        "r.id as id",
        "r.name as name",
        "r.description as description",
        "r.origin as origin",
        "r.did as did",
        "img.blob_cid as blob_cid",
        "img.blob_mime as blob_mime",
        "attr.display_name as attr_display_name",
        "attr.author as attr_author",
        "attr.publisher as attr_publisher",
        "attr.url as attr_url",
        "repo.handle as repo_handle",
      ]);

    if (q) {
      // tsvector match OR a trigram-backed name substring for short/fuzzy terms.
      query = query
        .innerJoin("recipe_search as rs", "rs.recipe_id", "r.id")
        .where((eb) => eb.or([eb(sql`rs.search_tsv`, "@@", sql`websearch_to_tsquery('english', ${q})`), eb("r.name", "ilike", `%${q}%`)]))
        .orderBy(sql`ts_rank(rs.search_tsv, websearch_to_tsquery('english', ${q}))`, "desc")
        .orderBy("r.name", "asc");
    } else {
      // No query → most recent public recipes not yet boxed.
      query = query.orderBy(sql`coalesce(r.published_at, r.record_created_at, r.indexed_at)`, "desc");
    }

    const rows = await query
      .limit(data.limit + 1)
      .offset(data.cursor)
      .execute();
    const hasMore = rows.length > data.limit;
    const page = hasMore ? rows.slice(0, data.limit) : rows;

    const results = page.map((row): GlobalRecipeResult => ({
      recipeId: row.id,
      title: row.name,
      description: row.description,
      source: deriveSource({
        origin: row.origin,
        id: row.id,
        repoHandle: row.repo_handle,
        attrDisplayName: row.attr_display_name,
        attrAuthor: row.attr_author,
        attrPublisher: row.attr_publisher,
        attrUrl: row.attr_url,
      }),
      thumbUrl: row.did && row.blob_cid ? blobImageUrl(row.did, row.blob_cid, row.blob_mime, "feed_thumbnail") : null,
    }));

    return { results, nextCursor: hasMore ? String(data.cursor + data.limit) : null };
  });
