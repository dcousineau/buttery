import { createServerFn } from "@tanstack/react-start";
import { blobImageUrl } from "#/lib/atproto/images";
import { deriveSource, prettify, profileUrl, shortDid } from "#/lib/recipe-provenance";
import type { RecipeCardData, RecipeDetailData } from "#/lib/api/types";

// Read-side browse/detail queries over the rendered `recipe` layer (see the
// recipe_rendered migration + the cron's render.ts). These power the home-page
// "recently published" grid and the full-page recipe view. Everything here is
// server-only: `getDb()` (pg) is pulled in via a dynamic import inside each
// handler so this module stays safe to reference from the client bundle.

/**
 * The wire DTOs this module returns are declared in the port's `types.ts` and
 * imported from there (offline plan §4.3 / §7): the client caches these shapes
 * in IndexedDB, versions them, and must be able to name them without importing
 * a server module — so it owns the declaration. Re-exported here for the
 * server-side callers that already reach for them through this module.
 */
export type { RecipeCardData, RecipeDetailData };

interface CardRow {
  id: string;
  name: string;
  description: string | null;
  did: string | null;
  published_at: Date | null;
  record_created_at: Date | null;
  indexed_at: Date | null;
  blob_cid: string | null;
  blob_mime: string | null;
  img_alt: string | null;
  attr_kind: string | null;
  attr_display_name: string | null;
  attr_author: string | null;
  attr_publisher: string | null;
  attr_url: string | null;
  repo_handle: string | null;
}

function toCard(row: CardRow): RecipeCardData {
  const publishedAt = row.published_at ?? row.record_created_at ?? row.indexed_at ?? null;
  const imageUrl = row.did && row.blob_cid ? blobImageUrl(row.did, row.blob_cid, row.blob_mime, "feed_fullsize") : null;
  // The publisher is the atproto account that owns the record: its handle
  // ("@foo.bsky.app"), else a short DID. Never an attribution name — that is a
  // credit, not an account, and it has its own segment in every byline below.
  const publishedBy = row.repo_handle ? `@${row.repo_handle}` : shortDid(row.did);
  // Only link the publisher when we have a resolved handle — bsky.app profiles
  // key on the handle, not the DID, so a DID-only repo isn't linkable.
  const publisherUrl = profileUrl(row.repo_handle);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
    imageUrl,
    imageAlt: row.img_alt,
    publishedBy,
    publisherUrl,
    // `repoHandle: null` because the publishing account is rendered beside this,
    // never through it — the same derivation the box uses, minus the handle rung
    // that would otherwise print the account twice.
    source: deriveSource({
      repoHandle: null,
      attrDisplayName: row.attr_display_name,
      attrAuthor: row.attr_author,
      attrPublisher: row.attr_publisher,
      attrUrl: row.attr_url,
    }),
  };
}

/** The 10 most recently published public recipes, for the home-page grid. */
export const listRecentRecipes = createServerFn({ method: "GET" }).handler(async (): Promise<RecipeCardData[]> => {
  try {
    const { getDb } = await import("#/lib/db");
    const { sql } = await import("kysely");
    const rows = (await getDb()
      .selectFrom("recipe as r")
      // The primary image is ordinal 0.
      .leftJoin("recipe_image as img", (join) => join.onRef("img.recipe_id", "=", "r.id").on("img.ordinal", "=", 0))
      .leftJoin("recipe_attribution as attr", "attr.recipe_id", "r.id")
      .leftJoin("atproto_repo as repo", "repo.did", "r.did")
      .select([
        "r.id",
        "r.name",
        "r.description",
        "r.did",
        "r.published_at",
        "r.record_created_at",
        "r.indexed_at",
        "img.blob_cid",
        "img.blob_mime",
        "img.alt as img_alt",
        "attr.kind as attr_kind",
        "attr.display_name as attr_display_name",
        "attr.author as attr_author",
        "attr.publisher as attr_publisher",
        "attr.url as attr_url",
        "repo.handle as repo_handle",
      ])
      .where("r.visibility", "=", "public")
      .orderBy(sql`coalesce(r.published_at, r.record_created_at, r.indexed_at)`, "desc")
      .limit(10)
      .execute()) as CardRow[];
    return rows.map(toCard);
  } catch (err) {
    // A missing table (migration not yet applied) or an unreachable DB should
    // degrade the home page to "no recipes yet", never crash the render.
    console.warn("[recipes-browse] listRecentRecipes failed", err);
    return [];
  }
});

/** One public recipe by id (ULID/TID), fully expanded for the detail page. */
export const getRecipe = createServerFn({ method: "GET" })
  .validator((id: string) => {
    // Recipe ids are atproto rkeys, which permit far more than ULID/TID shape
    // (hyphens, dots, tildes, …). We can't validate the shape — the DB is the
    // only source of truth for whether an id exists — so accept any non-empty
    // string. The length cap is an abuse guard, not a format check; the id is
    // always bound as a query parameter, never interpolated.
    if (typeof id !== "string" || id.length === 0 || id.length > 512) throw new Error("Invalid recipe id");
    return id;
  })
  .handler(async ({ data: id }): Promise<RecipeDetailData | null> => {
    const { getDb } = await import("#/lib/db");
    const db = getDb();

    const row = await db
      .selectFrom("recipe as r")
      .leftJoin("recipe_attribution as attr", "attr.recipe_id", "r.id")
      .leftJoin("atproto_repo as repo", "repo.did", "r.did")
      .select([
        "r.id",
        "r.name",
        "r.description",
        "r.did",
        "r.uri",
        "r.published_at",
        "r.record_created_at",
        "r.indexed_at",
        "r.recipe_yield",
        "r.prep_time",
        "r.cook_time",
        "r.total_time",
        "r.recipe_cuisine",
        "r.recipe_category",
        "r.cooking_method",
        "r.suitable_for_diet",
        "r.calories",
        "attr.kind as attr_kind",
        "attr.display_name as attr_display_name",
        "attr.author as attr_author",
        "attr.publisher as attr_publisher",
        "attr.url as attr_url",
        "repo.handle as repo_handle",
      ])
      .where("r.id", "=", id)
      .where("r.visibility", "=", "public")
      .executeTakeFirst();

    if (!row) return null;

    // Enrichment rides along in the same batch as everything else on the detail
    // payload — the tag strip is part of the page, not a second request. Its
    // read seam is `server/recipe-enrichment.ts`; this is that module's first
    // production caller.
    const { enrichmentTagLabels, getRecipeEnrichment } = await import("./recipe-enrichment");

    const [images, ingredients, instructions, keywords, enrichment] = await Promise.all([
      db.selectFrom("recipe_image").select(["blob_cid", "blob_mime", "alt", "aspect_w", "aspect_h"]).where("recipe_id", "=", id).orderBy("ordinal").execute(),
      db.selectFrom("recipe_ingredient").select("text").where("recipe_id", "=", id).orderBy("ordinal").execute(),
      db.selectFrom("recipe_instruction").select("text").where("recipe_id", "=", id).orderBy("ordinal").execute(),
      db.selectFrom("recipe_keyword").select("keyword").where("recipe_id", "=", id).execute(),
      getRecipeEnrichment(db, id),
    ]);

    const card = toCard({
      ...row,
      blob_cid: images[0]?.blob_cid ?? null,
      blob_mime: images[0]?.blob_mime ?? null,
      img_alt: images[0]?.alt ?? null,
    });

    return {
      ...card,
      // Derived, never published: nothing here reaches the JSON-LD or the
      // microdata, both of which are built from raw author fields only.
      enrichment: enrichmentTagLabels(enrichment),
      uri: row.uri,
      did: row.did,
      images: images
        .filter((img) => row.did && img.blob_cid)
        .map((img) => ({
          url: blobImageUrl(row.did as string, img.blob_cid as string, img.blob_mime, "feed_fullsize"),
          alt: img.alt,
          aspectW: img.aspect_w,
          aspectH: img.aspect_h,
        })),
      ingredients: ingredients.map((i) => i.text),
      instructions: instructions.map((i) => i.text),
      keywords: keywords.map((k) => k.keyword),
      recipeYield: row.recipe_yield,
      prepTime: row.prep_time,
      cookTime: row.cook_time,
      totalTime: row.total_time,
      cuisine: prettify(row.recipe_cuisine),
      category: prettify(row.recipe_category),
      cookingMethod: prettify(row.cooking_method),
      suitableForDiet: (row.suitable_for_diet ?? []).map((s) => prettify(s)).filter((s): s is string => Boolean(s)),
      calories: row.calories,
      attribution:
        row.attr_kind && (row.attr_display_name || row.attr_author || row.attr_publisher || row.attr_url)
          ? {
              kind: row.attr_kind,
              displayName: row.attr_display_name,
              author: row.attr_author,
              publisher: row.attr_publisher,
              url: row.attr_url,
            }
          : null,
    };
  });
