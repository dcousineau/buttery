import { createServerFn } from "@tanstack/react-start";
import { blobImageUrl } from "#/lib/atproto/images";

// Read-side browse/detail queries over the rendered `recipe` layer (see the
// recipe_rendered migration + the cron's render.ts). These power the home-page
// "recently published" grid and the full-page recipe view. Everything here is
// server-only: `getDb()` (pg) is pulled in via a dynamic import inside each
// handler so this module stays safe to reference from the client bundle.

export interface RecipeCardData {
  id: string;
  name: string;
  description: string | null;
  /** ISO timestamp we consider the recipe "published", or null. */
  publishedAt: string | null;
  imageUrl: string | null;
  imageAlt: string | null;
  /** Who published it — the atproto handle, else a short DID, else null. */
  publishedBy: string | null;
  /** Link to the publisher's profile (Bluesky appview), or null. */
  publisherUrl: string | null;
  /** Which app it was published under, if we can tell. Often null. */
  app: string | null;
  /** Deep link to this recipe on the source app, or null. */
  appUrl: string | null;
}

export interface RecipeDetailData extends RecipeCardData {
  uri: string | null;
  did: string | null;
  images: Array<{ url: string; alt: string | null; aspectW: number | null; aspectH: number | null }>;
  ingredients: string[];
  instructions: string[];
  keywords: string[];
  recipeYield: string | null;
  prepTime: string | null;
  cookTime: string | null;
  totalTime: string | null;
  cuisine: string | null;
  category: string | null;
  cookingMethod: string | null;
  suitableForDiet: string[];
  calories: number | null;
  attribution: {
    kind: string;
    displayName: string | null;
    author: string | null;
    publisher: string | null;
    url: string | null;
  } | null;
}

/** did:plc:abcdef… → did:plc:abcdef (short, still recognizable). */
function shortDid(did: string | null): string | null {
  if (!did) return null;
  return did.length > 24 ? `${did.slice(0, 21)}…` : did;
}

/**
 * Profile link for a publisher account. We route to the Bluesky appview, which
 * resolves any atproto account — including accounts whose handle lives on
 * another domain (e.g. *.blacksky.app). bsky.app's `/profile/` route needs the
 * HANDLE, not the DID, so a DID-only repo (handle unresolved) gets no link.
 * A handle's domain does NOT reliably indicate which appview its owner uses, so
 * bsky.app is the safe universal default; add alt-appview routing to
 * APPVIEW_OVERRIDES when a given handle-suffix → profile-URL scheme is known.
 */
const APPVIEW_OVERRIDES: Array<{ suffix: string; url: (handle: string) => string }> = [
  // e.g. { suffix: ".blacksky.app", url: (h) => `https://blacksky.app/profile/${h}` },
];

function profileUrl(handle: string | null): string | null {
  if (!handle) return null;
  const hit = APPVIEW_OVERRIDES.find((o) => handle.endsWith(o.suffix));
  if (hit) return hit.url(handle);
  return `https://bsky.app/profile/${encodeURIComponent(handle)}`;
}

/** slug ("gluten_free") → label ("Gluten Free") for display. */
function prettify(slug: string | null): string | null {
  if (!slug) return null;
  return slug
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Best-effort "which app published this" + a deep link to the recipe there.
 * atproto records carry NO provenance of the writing app — the
 * exchange.recipe.recipe lexicon has no client/via field — so this is a
 * heuristic, not a fact:
 *   - origin 'local' → Buttery wrote it (we know; we're the writer). No external
 *     link — the recipe already lives here.
 *   - origin 'sync'  → recipe.exchange is currently the only app publishing this
 *     NSID to the network. Its canonical URL is `/recipes/{rkey}`, and our
 *     recipe.id IS the rkey (a ULID), so the deep link is derivable. Revisit if
 *     a second producer ever appears.
 */
function deriveApp(origin: string, id: string): { name: string; url: string | null } {
  if (origin === "local") return { name: "Buttery", url: null };
  return { name: "recipe.exchange", url: `https://recipe.exchange/recipes/${encodeURIComponent(id)}` };
}

interface CardRow {
  id: string;
  name: string;
  description: string | null;
  origin: string;
  did: string | null;
  published_at: Date | null;
  record_created_at: Date | null;
  indexed_at: Date | null;
  blob_cid: string | null;
  blob_mime: string | null;
  img_alt: string | null;
  attr_display_name: string | null;
  attr_author: string | null;
  attr_url: string | null;
  repo_handle: string | null;
}

function toCard(row: CardRow): RecipeCardData {
  const publishedAt = row.published_at ?? row.record_created_at ?? row.indexed_at ?? null;
  const imageUrl = row.did && row.blob_cid ? blobImageUrl(row.did, row.blob_cid, row.blob_mime, "feed_fullsize") : null;
  // The publisher is the atproto account that owns the record. Prefer its handle
  // ("@foo.bsky.app"); fall back to attribution or a short DID.
  const publishedBy = row.repo_handle ? `@${row.repo_handle}` : (row.attr_display_name ?? row.attr_author ?? shortDid(row.did));
  // Only link the publisher when we have a resolved handle — bsky.app profiles
  // key on the handle, not the DID, so a DID-only repo isn't linkable.
  const publisherUrl = profileUrl(row.repo_handle);
  const app = deriveApp(row.origin, row.id);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
    imageUrl,
    imageAlt: row.img_alt,
    publishedBy,
    publisherUrl,
    app: app.name,
    appUrl: app.url,
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
        "r.origin",
        "r.did",
        "r.published_at",
        "r.record_created_at",
        "r.indexed_at",
        "img.blob_cid",
        "img.blob_mime",
        "img.alt as img_alt",
        "attr.display_name as attr_display_name",
        "attr.author as attr_author",
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
        "r.origin",
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

    const [images, ingredients, instructions, keywords] = await Promise.all([
      db.selectFrom("recipe_image").select(["blob_cid", "blob_mime", "alt", "aspect_w", "aspect_h"]).where("recipe_id", "=", id).orderBy("ordinal").execute(),
      db.selectFrom("recipe_ingredient").select("text").where("recipe_id", "=", id).orderBy("ordinal").execute(),
      db.selectFrom("recipe_instruction").select("text").where("recipe_id", "=", id).orderBy("ordinal").execute(),
      db.selectFrom("recipe_keyword").select("keyword").where("recipe_id", "=", id).execute(),
    ]);

    const card = toCard({
      ...row,
      blob_cid: images[0]?.blob_cid ?? null,
      blob_mime: images[0]?.blob_mime ?? null,
      img_alt: images[0]?.alt ?? null,
    });

    return {
      ...card,
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
