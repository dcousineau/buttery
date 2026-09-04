import { createServerFn } from "@tanstack/react-start";
import type { Kysely } from "kysely";
import type { DB } from "#/db/types";
import { blobImageUrl } from "#/lib/atproto/images";
import { deriveSource, prettify, profileUrl } from "#/lib/recipe-provenance";
import type { GlobalRecipeResult, HouseholdRecipeDetail, HouseholdRecipeNoteView, HouseholdRecipeRow, RecipeNutrition } from "#/lib/api/types";

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

/**
 * The wire DTOs this module returns are declared in the port's `types.ts` and
 * imported from there (offline plan §4.3 / §7): the client caches these shapes
 * in IndexedDB, versions them, and must be able to name them without importing
 * a server module — so it owns the declaration. Re-exported here for the
 * server-side callers that already reach for them through this module.
 */
export type { GlobalRecipeResult, HouseholdRecipeDetail, HouseholdRecipeNoteView, HouseholdRecipeRow, RecipeNutrition };

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

/**
 * "@handle" for each of `dids`, batched — the adder-attribution lookup, never a
 * per-row query and never the `atproto_repo as repo` join the recipe queries use
 * (that one resolves the recipe's PUBLISHER via `r.did`).
 *
 * Two tables, one round-trip. `atproto_repo` is filled by the sync worker, so it
 * only knows DIDs whose repos we have crawled — someone who signed in and boxed
 * a recipe without ever publishing one is simply absent from it. `user` is the
 * sign-in table and therefore has every possible adder, so it is the fallback.
 * Repo wins when both know the DID: it is the handle the network currently
 * resolves, where `user.handle` is a snapshot from whenever they last signed in.
 *
 * That precedence is carried by the `priority` literal rather than by two awaits
 * — `order by priority` puts the repo rows last, so writing straight into the
 * map lets them overwrite the sign-in ones. `user` is the base arm because its
 * `did` is nullable and `atproto_repo`'s is not, and a union arm must be
 * assignable to the base.
 *
 * Exported because it is the household's one DID → "@handle" batch: the
 * collections read (`server/collections.ts`) resolves a published collection's
 * publisher through this exact lookup, and a second copy of the precedence rule
 * above would be a second thing to keep in step.
 */
export async function resolveAdderHandles(db: Kysely<DB>, dids: string[]): Promise<Map<string, string>> {
  const byDid = new Map<string, string>();
  if (dids.length === 0) return byDid;

  const rows = await db
    .selectFrom("user")
    .select((eb) => ["did", "handle", eb.lit<number>(0).as("priority")])
    .where("did", "in", dids)
    .unionAll(
      db
        .selectFrom("atproto_repo")
        .select((eb) => ["did", "handle", eb.lit<number>(1).as("priority")])
        .where("did", "in", dids),
    )
    .orderBy("priority")
    .execute();

  for (const row of rows) if (row.did && row.handle) byDid.set(row.did, `@${row.handle}`);
  return byDid;
}

// --- §6.1 listHouseholdRecipes ------------------------------------------

/**
 * The whole box in one shot (small N; filter/sort/search are client-side). The
 * `householdScopedQuery` membership join is the authorization gate.
 */
export const listHouseholdRecipes = createServerFn({ method: "GET" }).handler(async (): Promise<HouseholdRecipeRow[]> => {
  const { getDb } = await import("#/lib/db");
  const { householdScopedQuery } = await import("./household/scoped-query");
  const { presignDownload } = await import("#/lib/blob-storage");
  const { did, householdId } = await activeContext();
  const db = getDb();

  const rows = await householdScopedQuery(db, did, householdId)
    .innerJoin("household_recipe as hr", "hr.household_id", "hm.household_id")
    .innerJoin("recipe as r", "r.id", "hr.recipe_id")
    .leftJoin("recipe_image as img", (join) => join.onRef("img.recipe_id", "=", "r.id").on("img.ordinal", "=", 0))
    // A draft's photo lives in our bucket, not as a blob ref. The key is joined
    // so the row can be handed a signed URL straight to the object, and an
    // unpublished recipe shows its thumbnail in the box like any other.
    .leftJoin("recipe_pending_image as pimg", "pimg.recipe_id", "r.id")
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
      "hr.added_by_did as added_by_did",
      "img.blob_cid as blob_cid",
      "img.blob_mime as blob_mime",
      "pimg.object_key as pending_object_key",
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

  const handleByDid = await resolveAdderHandles(db, [...new Set(rows.map((r) => r.added_by_did))]);

  // A draft hero is a signed URL onto the bucket, minted here because here is
  // where the caller has already passed the household check that authorizes it.
  // Signing is a local HMAC, not a round trip, so a page of them costs nothing
  // worth batching.
  return await Promise.all(
    rows.map(async (row): Promise<HouseholdRecipeRow> => {
      const { minutes, display } = minutesDisplay(row.total_time_seconds);
      const source = deriveSource({
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
        sourceKind: source?.kind ?? null,
        sourceLabel: source?.label ?? null,
        sourceUrl: source?.url ?? null,
        totalMinutes: minutes,
        totalTimeDisplay: display,
        keywords: keywordsByRecipe.get(row.id) ?? [],
        thumbUrl:
          row.did && row.blob_cid
            ? blobImageUrl(row.did, row.blob_cid, row.blob_mime, "feed_thumbnail")
            : row.pending_object_key
              ? await presignDownload(row.pending_object_key)
              : null,
        addedAt: new Date(row.added_at).toISOString(),
        addedByHandle: handleByDid.get(row.added_by_did) ?? null,
        unavailable,
        unpublished: row.visibility !== "public" || row.uri == null,
      };
    }),
  );
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
    const { did, householdId } = await activeContext();
    return await readHouseholdRecipeDetail(getDb(), did, householdId, data.recipeId);
  });

/**
 * The detail read itself, split out from the server fn for the same reason
 * `getRecipeEnrichment` is a plain function: `household-recipes.db.test.ts` can
 * exercise the query — including the membership gate — without faking a
 * session. `did`/`householdId` MUST still come from the validated session.
 */
export async function readHouseholdRecipeDetail(db: Kysely<DB>, did: string, householdId: string, recipeId: string): Promise<HouseholdRecipeDetail | null> {
  const { householdScopedQuery } = await import("./household/scoped-query");

  // ONE round trip carries the authorization, the recipe row, and every child
  // collection. `householdScopedQuery` + the `household_recipe` join IS both
  // the authz gate and the 404 — you may only read content for recipes in
  // YOUR box — and there is deliberately no visibility filter, because this
  // must still render a recipe whose source has since gone unavailable (the
  // whole point of the cache). The children ride along as json sub-selects
  // rather than a fan-out of one-table-each queries: each is keyed by
  // `recipe_id` (plus `household_id` for the note), so a second round trip
  // has nothing left to learn.
  const { jsonArrayFrom, jsonObjectFrom } = await import("kysely/helpers/postgres");
  const row = await householdScopedQuery(db, did, householdId)
    .innerJoin("household_recipe as hr", "hr.household_id", "hm.household_id")
    .innerJoin("recipe as r", "r.id", "hr.recipe_id")
    .leftJoin("recipe_attribution as attr", "attr.recipe_id", "r.id")
    .leftJoin("atproto_repo as repo", "repo.did", "r.did")
    .leftJoin("atproto_collection_recipe as acr", (join) => join.onRef("acr.did", "=", "r.did").onRef("acr.rkey", "=", "r.rkey"))
    .where("hr.recipe_id", "=", recipeId)
    .select((eb) => [
      "hr.favorite as favorite",
      "hr.added_by_did as added_by_did",
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
      // The AUTHOR's own declared diets — the tag strip shows these beside
      // whatever the pipeline derived, and the author's wins on collision.
      "r.suitable_for_diet as suitable_for_diet",
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
      jsonArrayFrom(eb.selectFrom("recipe_image as ri").select(["ri.blob_cid", "ri.blob_mime", "ri.alt"]).whereRef("ri.recipe_id", "=", "r.id").orderBy("ri.ordinal")).as("images"),
      // Draft/private hero: a not-yet-published recipe keeps its photo in OUR
      // bucket. The page gets a signed URL onto that object — minted below,
      // where the caller has already passed the household check that authorizes
      // it. This used to select `source_url` and render a third-party URL
      // straight into the page, and then a proxy route on our own origin.
      jsonObjectFrom(eb.selectFrom("recipe_pending_image as pimg").select(["pimg.object_key", "pimg.alt"]).whereRef("pimg.recipe_id", "=", "r.id").limit(1)).as("pending_image"),
      jsonArrayFrom(eb.selectFrom("recipe_ingredient as ring").select("ring.text").whereRef("ring.recipe_id", "=", "r.id").orderBy("ring.ordinal")).as("ingredients"),
      jsonArrayFrom(eb.selectFrom("recipe_instruction as rins").select("rins.text").whereRef("rins.recipe_id", "=", "r.id").orderBy("rins.ordinal")).as("instructions"),
      jsonArrayFrom(eb.selectFrom("recipe_keyword as rkw").select("rkw.keyword").whereRef("rkw.recipe_id", "=", "r.id")).as("keywords"),
      jsonObjectFrom(
        eb
          .selectFrom("household_recipe_note as hrn")
          .select(["hrn.body", "hrn.updated_at"])
          .whereRef("hrn.recipe_id", "=", "r.id")
          .where("hrn.household_id", "=", householdId)
          .limit(1),
      ).as("note"),
    ])
    .executeTakeFirst();
  if (!row) return null;

  // What is left is the handful of reads that are NOT a child table of this
  // recipe — each owned by another module, each carrying a rule (a household
  // timezone, a label vocabulary, a membership preference) that a hand-rolled
  // sub-select here would be a second copy of. They run in one parallel wave,
  // after the box row above has authorized this household + recipe pair.
  //
  // §7.2: the planner's "is this planned?" read rides along, so the remove
  // flow costs no extra round trip. `readPlannedUsage` is the planner's own
  // query — never a second copy of it here.
  const { readPlannedUsage } = await import("./meal-plan");
  // Same ride-along reasoning as `plannedUsage` above, with one extra
  // consequence worth naming: riding on THIS payload is what puts enrichment
  // into the offline IndexedDB cache, so a boxed recipe opened offline still
  // shows its tags.
  const { enrichmentTagLabels, getRecipeEnrichment } = await import("./recipe-enrichment");
  // Whether autoimport pins this recipe in the box rides along too: the pane
  // disables Remove with it, so the only way to learn about the refusal is
  // not by pressing the button and catching a 409.
  const { autoimportPinnedBy } = await import("./household/autoimport");

  const [plannedUsage, enrichment, pinnedByDid, adderHandles] = await Promise.all([
    readPlannedUsage(db, householdId, recipeId),
    getRecipeEnrichment(db, recipeId),
    autoimportPinnedBy(db, householdId, recipeId),
    resolveAdderHandles(db, [row.added_by_did]),
  ]);
  const adder = adderHandles.get(row.added_by_did) ?? null;

  const { minutes, display } = minutesDisplay(row.total_time_seconds);
  const source = deriveSource({
    repoHandle: row.repo_handle,
    attrDisplayName: row.attr_display_name,
    attrAuthor: row.attr_author,
    attrPublisher: row.attr_publisher,
    attrUrl: row.attr_url,
  });
  const { parseServes } = await import("#/lib/recipe-scale");
  const unavailable = row.origin === "sync" && (row.acr_deleted_at !== null || row.acr_validation_status == null || row.acr_validation_status !== "valid");

  // The pin is always the recipe's own publisher (`r.did`), which is exactly
  // the DID `repo.handle` was joined on above — so naming them costs no extra
  // query. `resolveAdderHandles` is the fallback for a publisher we have a
  // membership row for but no crawled repo (they signed in, never synced).
  let autoimportLock: { handle: string | null; isSelf: boolean } | null = null;
  if (pinnedByDid) {
    const handle = row.repo_handle ? `@${row.repo_handle}` : ((await resolveAdderHandles(db, [pinnedByDid])).get(pinnedByDid) ?? null);
    autoimportLock = { handle, isSelf: pinnedByDid === did };
  }

  // A published recipe renders from an atproto CDN; before that, from a signed
  // URL onto our bucket. There is no third case and no `<img src>` on someone
  // else's host.
  const published = row.images
    .filter((img) => row.did && img.blob_cid)
    .map((img) => ({ url: blobImageUrl(row.did as string, img.blob_cid as string, img.blob_mime, "feed_fullsize"), alt: img.alt }));
  let heroImages = published;
  if (!published.length && row.pending_image) {
    const { presignDownload } = await import("#/lib/blob-storage");
    heroImages = [{ url: await presignDownload(row.pending_image.object_key), alt: row.pending_image.alt }];
  }

  return {
    recipeId: row.id,
    title: row.name,
    description: row.description,
    source,
    images: heroImages,
    ingredients: row.ingredients.map((i) => i.text),
    instructions: row.instructions.map((i) => i.text),
    keywords: row.keywords.map((k) => k.keyword),
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
    favorite: row.favorite,
    note: row.note ? { body: row.note.body, updatedAt: new Date(row.note.updated_at).toISOString() } : null,
    addedByHandle: adder,
    unavailable,
    unavailableSince: row.acr_deleted_at ? new Date(row.acr_deleted_at).toISOString() : null,
    unpublished: row.visibility !== "public" || row.uri == null,
    plannedUsage,
    autoimportLock,
    suitableForDiet: (row.suitable_for_diet ?? []).map((slug) => prettify(slug)).filter((label): label is string => label !== null),
    enrichment: enrichmentTagLabels(enrichment),
  };
}

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

/**
 * Remove a recipe from the box (cascades its shared note, and — collections plan
 * §2.11 — unfiles it from every collection in the household). Idempotent.
 *
 * Never blocked by the meal plan (D8/§7.2): `meal_plan_entry.recipe_id` is FK'd
 * to `recipe`, not to `household_recipe`, so unlinking the box row cannot hit
 * that `ON DELETE RESTRICT` — the plan entry keeps rendering, now with
 * `inBox: false`. The warning is a UI courtesy (`DetailPane`), not a gate.
 *
 * The collection unfiling is the composite FK's doing (`recipe_collection_entry
 * (household_id, recipe_id)` → `household_recipe` ON DELETE CASCADE), not this
 * function's — but a cascade leaves holes in `position`, and the entry order IS
 * the published array order. So the whole thing runs in ONE transaction: collect
 * the affected collections, delete the box row, renumber each of them densely.
 */
export const removeRecipeFromHousehold = createServerFn({ method: "POST" })
  .validator((data: { recipeId: string }) => ({ recipeId: validateRecipeId(data?.recipeId) }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);

    await unboxRecipe(getDb(), householdId, data.recipeId);
    return { ok: true };
  });

/**
 * The body of `removeRecipeFromHousehold`, callable by an already-authorized
 * server-side caller.
 *
 * Returns the collections the recipe was unfiled from, in sorted (lock) order,
 * and which of those could not be re-put — `staleCollectionIds` is a subset of
 * `unfiledFrom`, and every id in it now carries `record_stale`.
 */
export async function unboxRecipe(db: Kysely<DB>, householdId: string, recipeId: string): Promise<{ unfiledFrom: string[]; staleCollectionIds: string[] }> {
  const { collectionsHoldingRecipe, renumberAfterUnfile, reputEach } = await import("./collections");
  const { autoimportPinnedBy } = await import("./household/autoimport");
  const { AutoimportProtectedError } = await import("./household/errors");

  const unfiledFrom = await db.transaction().execute(async (trx) => {
    // A recipe published by a member who has Autoimport My Recipes on is
    // protected from removal (it would just reappear on the next sweep). The
    // detail payload reports the same fact ahead of time, so reaching this
    // throw means a stale client — not the normal path.
    if (await autoimportPinnedBy(trx, householdId, recipeId)) {
      throw new AutoimportProtectedError();
    }

    // Read (and therefore lock the read set of) the affected collections BEFORE
    // the delete, because the cascade is about to take those rows away.
    const affected = await collectionsHoldingRecipe(trx, householdId, recipeId);
    await trx.deleteFrom("household_recipe").where("household_id", "=", householdId).where("recipe_id", "=", recipeId).execute();
    await renumberAfterUnfile(trx, affected);
    return affected;
  });

  // AFTER COMMIT (§2.11, §5): every published collection that just lost a ref
  // gets its record rebuilt. `reputEach` never throws — leaving the box must not
  // fail because someone's PDS is unreachable — so a failure only annotates.
  const staleCollectionIds = await reputEach(db, unfiledFrom);
  return { unfiledFrom, staleCollectionIds };
}

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
      // `repoHandle: null` because the publishing account renders beside this on
      // the network surfaces, never through it — the handle rung would print the
      // account twice.
      source: deriveSource({
        repoHandle: null,
        attrDisplayName: row.attr_display_name,
        attrAuthor: row.attr_author,
        attrPublisher: row.attr_publisher,
        attrUrl: row.attr_url,
      }),
      // Public recipes only, so the image is always an atproto blob: no pending
      // fallback here, and the caller has no box row that would authorize one.
      thumbUrl: row.did && row.blob_cid ? blobImageUrl(row.did, row.blob_cid, row.blob_mime, "feed_thumbnail") : null,
      // Same `repo` join the source derivation reads — prefixed the way every
      // other handle in this module is surfaced.
      handle: row.repo_handle ? `@${row.repo_handle}` : null,
      handleUrl: profileUrl(row.repo_handle),
    }));

    return { results, nextCursor: hasMore ? String(data.cursor + data.limit) : null };
  });
