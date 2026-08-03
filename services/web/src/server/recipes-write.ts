import { createServerFn } from "@tanstack/react-start";
import dayjs from "dayjs";
import duration from "dayjs/plugin/duration.js";
import { $safeValidate } from "@buttery/lexicons/exchange/recipe/recipe";
import type { Main as RecipeRecord } from "@buttery/lexicons/exchange/recipe/recipe";
import { slugForToken } from "#/lib/recipe-vocab";

dayjs.extend(duration);

// Local recipe authoring: save a draft to the household box and/or publish it to
// the author's atproto PDS. The wire contract is the exchange.recipe.recipe
// record shape (minus the server-stamped $type/timestamps) wrapped in a thin
// Buttery envelope. See docs/plans/2026-08-02-create-recipes.md §A2.
//
// Server-only deps (db, blob storage, atproto client) are pulled in via dynamic
// import() inside the handlers so this module stays out of the client bundle.

// The record the client sends — everything the author controls. $type and the
// createdAt/updatedAt timestamps are stamped server-side; `embed` (the image
// blob) is built server-side on publish, never sent over the wire.
export type RecipeRecordInput = Omit<RecipeRecord, "$type" | "createdAt" | "updatedAt" | "embed">;

export interface RecipeImageInput {
  /** base64 (no data: prefix) of the image bytes; ≤1MB decoded. */
  dataBase64: string;
  mime: string;
  alt?: string;
}

export interface SaveRecipeInput {
  record: RecipeRecordInput;
  /** Where the draft lands. Publishing is a separate boolean, not a visibility. */
  visibility: "draft" | "private";
  publish: boolean;
  /** Set for imported recipes; locks Website attribution + drives dedupe. */
  sourceUrl?: string | null;
  image?: RecipeImageInput | null;
  /**
   * An imported hero image we haven't fetched yet (cross-origin — the client
   * can't turn it into bytes). Stored as a `recipe_pending_image.source_url`
   * pointer; the bytes are fetched (SSRF-guarded) and uploaded to the PDS on
   * publish. Ignored when `image` (uploaded bytes) is present.
   */
  imageSourceUrl?: string | null;
}

export interface FieldIssue {
  path: string;
  message: string;
}

export type SaveRecipeResult =
  | { status: "ok"; recipeId: string; published: boolean }
  | { status: "invalid"; issues: FieldIssue[] }
  | { status: "duplicate"; existingRecipeId: string }
  // Publishing is turned off by the atproto-publishing kill switch. Any draft was
  // still saved; `recipeId` points at it so the caller can land on the draft.
  | { status: "publish_disabled"; recipeId: string };

// --- attribution enforcement --------------------------------------------

const ATTR_TYPE_PREFIX = "exchange.recipe.defs#attribution";

/** Bare hostname of a URL ("https://www.smittenkitchen.com/…" → "smittenkitchen.com"). */
function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Enforce Buttery's non-negotiable attribution rule (the lexicon marks it
 * optional; we don't). For imported recipes, re-derive a Website attribution
 * server-side from the source URL — the client's attribution is never trusted
 * when `sourceUrl` is present. Returns the attribution object, or null if the
 * caller must be rejected.
 */
function resolveAttribution(record: RecipeRecordInput, sourceUrl: string | null): RecipeRecord["attribution"] | null {
  if (sourceUrl) {
    const name = domainOf(sourceUrl);
    return {
      $type: "exchange.recipe.defs#attributionWebsite",
      url: sourceUrl,
      name: name ?? sourceUrl,
    } as RecipeRecord["attribution"];
  }
  const attr = record.attribution as { $type?: string } | undefined;
  if (!attr || typeof attr.$type !== "string" || !attr.$type.startsWith(ATTR_TYPE_PREFIX)) {
    return null;
  }
  return record.attribution;
}

// --- normalization (mirror services/atproto-cron-sync/src/render.ts) -----

function durationSeconds(v: string | null | undefined): number | null {
  if (!v || v[0] !== "P") return null;
  const secs = dayjs.duration(v).asSeconds();
  return Number.isFinite(secs) && secs > 0 ? Math.round(secs) : null;
}

function attributionKind(type: string | undefined): string {
  const frag = type?.split("#attribution")[1];
  return frag ? frag[0].toLowerCase() + frag.slice(1) : "unknown";
}

interface FlatAttribution {
  kind: string;
  displayName: string | null;
  author: string | null;
  publisher: string | null;
  url: string | null;
  license: string | null;
  raw: Record<string, unknown>;
}

function flattenAttribution(attr: RecipeRecord["attribution"]): FlatAttribution | null {
  const a = attr as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object") return null;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    kind: attributionKind(str(a.$type) ?? undefined),
    displayName: str(a.name) ?? str(a.title),
    author: str(a.author),
    publisher: str(a.publisher),
    url: str(a.url),
    license: str(a.license),
    raw: a,
  };
}

// --- server functions ----------------------------------------------------

export const saveRecipe = createServerFn({ method: "POST" })
  .validator((data: SaveRecipeInput) => data)
  .handler(async ({ data }): Promise<SaveRecipeResult> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);

    return await runSave(getDb(), { did, householdId }, data);
  });

export const publishRecipe = createServerFn({ method: "POST" })
  .validator((data: { recipeId: string }) => ({ recipeId: String(data?.recipeId ?? "") }))
  .handler(async ({ data }): Promise<SaveRecipeResult> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);

    return await runPublishExisting(getDb(), { did, householdId }, data.recipeId);
  });

// --- implementation ------------------------------------------------------

import type { Kysely } from "kysely";
import type { DB } from "#/db/types";

interface Ctx {
  did: string;
  householdId: string;
}

async function runSave(db: Kysely<DB>, ctx: Ctx, input: SaveRecipeInput): Promise<SaveRecipeResult> {
  const { sql } = await import("kysely");
  const { ulid } = await import("./household/ids");

  const sourceUrl = input.sourceUrl?.trim() || null;

  // 1. Attribution enforcement (imported → server-built Website; else required).
  const attribution = resolveAttribution(input.record, sourceUrl);
  if (!attribution) {
    return { status: "invalid", issues: [{ path: "attribution", message: "Choose where this recipe came from." }] };
  }

  // 2. Assemble the full record + lexicon validation gate.
  const now = new Date().toISOString();
  const full = {
    $type: "exchange.recipe.recipe",
    ...input.record,
    attribution,
    createdAt: now,
    updatedAt: now,
  };
  const validated = $safeValidate(full);
  if (!validated.success) {
    const issues: FieldIssue[] = validated.reason.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    return { status: "invalid", issues };
  }
  const record = validated.value as RecipeRecord;

  // 3. Dedupe (publish + import only): block a URL an existing PUBLIC record cites.
  if (input.publish && sourceUrl) {
    const dup = await db
      .selectFrom("recipe_attribution as a")
      .innerJoin("recipe as r", "r.id", "a.recipe_id")
      .select("r.id as id")
      .where("a.kind", "=", "website")
      .where(sql<boolean>`lower(a.url) = lower(${sourceUrl})`)
      .where("r.visibility", "=", "public")
      .where("r.uri", "is not", null)
      .limit(1)
      .executeTakeFirst();
    if (dup) return { status: "duplicate", existingRecipeId: dup.id };
  }

  // 4. Mint the stable ULID id and write the local (draft/private) rows.
  const recipeId = ulid();
  await insertLocalRecipe(db, ctx, recipeId, record, input.visibility);

  // 5. Pending image → bucket + pointer row (draft path). On the publish path we
  //    upload the blob directly instead (below), so skip the pending row there.
  if (input.image && !input.publish) {
    await storePendingImage(db, recipeId, input.image);
  } else if (!input.image && input.imageSourceUrl) {
    // Imported hero we haven't fetched (cross-origin). Remember the URL as a
    // pending pointer; publishLocalRecipe fetches + uploads it below (publish
    // path) or it waits here as a draft until a later publish.
    await storePendingImageSourceUrl(db, recipeId, input.imageSourceUrl, input.record.name);
  }

  if (!input.publish) {
    return { status: "ok", recipeId, published: false };
  }

  // 6. Publish — gated by the atproto-publishing kill switch. If disabled, the
  //    draft above is kept and we return without any PDS write.
  const { isAtprotoPublishEnabled } = await import("#/lib/posthog-server");
  if (!(await isAtprotoPublishEnabled(ctx.did))) {
    return { status: "publish_disabled", recipeId };
  }

  // Upload image blob (if any), write the record to the PDS with the ULID as
  // rkey, then flip the row public + reconcile the sync tables.
  await publishLocalRecipe(db, ctx, recipeId, record, input.image ?? null);
  return { status: "ok", recipeId, published: true };
}

async function runPublishExisting(db: Kysely<DB>, ctx: Ctx, recipeId: string): Promise<SaveRecipeResult> {
  if (!recipeId) return { status: "invalid", issues: [{ path: "recipeId", message: "Missing recipe." }] };

  // Load the caller's own draft and rebuild the record for the PDS write.
  const built = await buildRecordFromRow(db, ctx, recipeId);
  if (!built) return { status: "invalid", issues: [{ path: "recipeId", message: "Draft not found." }] };
  if (built.uri) return { status: "ok", recipeId, published: true }; // already public

  const validated = $safeValidate({ ...built.record, $type: "exchange.recipe.recipe" });
  if (!validated.success) {
    return { status: "invalid", issues: validated.reason.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  }

  // Dedupe against a published record for the same source URL (import → publish later).
  if (built.sourceUrl) {
    const { sql } = await import("kysely");
    const dup = await db
      .selectFrom("recipe_attribution as a")
      .innerJoin("recipe as r", "r.id", "a.recipe_id")
      .select("r.id as id")
      .where("a.kind", "=", "website")
      .where(sql<boolean>`lower(a.url) = lower(${built.sourceUrl})`)
      .where("r.visibility", "=", "public")
      .where("r.uri", "is not", null)
      .where("r.id", "!=", recipeId)
      .limit(1)
      .executeTakeFirst();
    if (dup) return { status: "duplicate", existingRecipeId: dup.id };
  }

  // Kill switch — publishing an existing draft is blocked the same way.
  const { isAtprotoPublishEnabled } = await import("#/lib/posthog-server");
  if (!(await isAtprotoPublishEnabled(ctx.did))) {
    return { status: "publish_disabled", recipeId };
  }

  await publishLocalRecipe(db, ctx, recipeId, validated.value as RecipeRecord, built.pendingImage);
  return { status: "ok", recipeId, published: true };
}

// Insert the recipe + all child rows for a new local (unpublished) recipe.
async function insertLocalRecipe(db: Kysely<DB>, ctx: Ctx, id: string, record: RecipeRecord, visibility: "draft" | "private"): Promise<void> {
  const { sql } = await import("kysely");
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("recipe")
      .values({
        id,
        origin: "local",
        visibility,
        name: record.name,
        description: record.text ?? null,
        recipe_yield: record.recipeYield ?? null,
        prep_time: record.prepTime ?? null,
        cook_time: record.cookTime ?? null,
        total_time: record.totalTime ?? null,
        prep_time_seconds: durationSeconds(record.prepTime),
        cook_time_seconds: durationSeconds(record.cookTime),
        total_time_seconds: durationSeconds(record.totalTime),
        cooking_method: slugForToken("cooking_method", record.cookingMethod),
        recipe_cuisine: slugForToken("cuisine", record.recipeCuisine),
        recipe_category: slugForToken("category", record.recipeCategory),
        suitable_for_diet: mapDietSlugs(record.suitableForDiet),
        calories: record.nutrition?.calories ?? null,
        fat_content: numOrNull(record.nutrition?.fatContent),
        protein_content: numOrNull(record.nutrition?.proteinContent),
        carbohydrate_content: numOrNull(record.nutrition?.carbohydrateContent),
        record_created_at: record.createdAt,
        record_updated_at: record.updatedAt,
      })
      .execute();

    await writeChildren(trx, id, record, sql);

    // Auto-box into the creator's active household (any visibility, immediately
    // private to the household). Idempotent.
    await trx
      .insertInto("household_recipe")
      .values({ household_id: ctx.householdId, recipe_id: id, added_by_did: ctx.did })
      .onConflict((oc) => oc.columns(["household_id", "recipe_id"]).doNothing())
      .execute();
  });
}

// Re-derive the child rows (ingredient/instruction/keyword/attribution/image/
// search) for a recipe. Delete-then-insert so it works for update too.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function writeChildren(trx: Kysely<DB>, id: string, record: RecipeRecord, sqlTag: any): Promise<void> {
  const sql = sqlTag;
  const ingredients = (record.ingredients ?? []).filter((s) => s.trim());
  const instructions = (record.instructions ?? []).filter((s) => s.trim());
  const keywords = [...new Set((record.keywords ?? []).filter((s) => s.trim()))];

  await trx.deleteFrom("recipe_ingredient").where("recipe_id", "=", id).execute();
  await trx.deleteFrom("recipe_instruction").where("recipe_id", "=", id).execute();
  await trx.deleteFrom("recipe_keyword").where("recipe_id", "=", id).execute();
  await trx.deleteFrom("recipe_attribution").where("recipe_id", "=", id).execute();

  if (ingredients.length) {
    await trx
      .insertInto("recipe_ingredient")
      .values(ingredients.map((text, ordinal) => ({ recipe_id: id, ordinal, text })))
      .execute();
  }
  if (instructions.length) {
    await trx
      .insertInto("recipe_instruction")
      .values(instructions.map((text, ordinal) => ({ recipe_id: id, ordinal, text })))
      .execute();
  }
  if (keywords.length) {
    await trx
      .insertInto("recipe_keyword")
      .values(keywords.map((keyword) => ({ recipe_id: id, keyword })))
      .execute();
  }

  const attr = flattenAttribution(record.attribution);
  if (attr) {
    await trx
      .insertInto("recipe_attribution")
      .values({
        recipe_id: id,
        kind: attr.kind,
        display_name: attr.displayName,
        author: attr.author,
        publisher: attr.publisher,
        url: attr.url,
        license: attr.license,
        raw: JSON.stringify(attr.raw),
      })
      .execute();
  }

  // Weighted search document (A=name, B=facets+attribution, C=ingredients,
  // D=description+instructions) — mirrors the cron's UPSERT_SEARCH_SQL.
  const { labelForSlug } = await import("#/lib/recipe-vocab");
  const vocabLabels = [
    labelForSlug("cooking_method", slugForToken("cooking_method", record.cookingMethod)),
    labelForSlug("cuisine", slugForToken("cuisine", record.recipeCuisine)),
    labelForSlug("category", slugForToken("category", record.recipeCategory)),
    ...(mapDietSlugs(record.suitableForDiet ?? []) ?? []).map((s) => labelForSlug("diet", s)),
  ].filter(Boolean) as string[];
  const attrText = attr ? [attr.displayName, attr.author, attr.publisher].filter(Boolean).join(" ") : "";
  const facets = [...keywords, ...vocabLabels, attrText].filter(Boolean).join(" ");
  const dText = [record.text ?? "", ...instructions].join(" ");

  await trx
    .insertInto("recipe_search")
    .values({
      recipe_id: id,
      search_tsv: sql`setweight(to_tsvector('english', ${record.name}), 'A') || setweight(to_tsvector('english', ${facets}), 'B') || setweight(to_tsvector('english', ${ingredients.join(" ")}), 'C') || setweight(to_tsvector('english', ${dText}), 'D')`,
    })
    .onConflict((oc) => oc.column("recipe_id").doUpdateSet({ search_tsv: sql`excluded.search_tsv` }))
    .execute();
}

// Store an imported hero as a URL-only pending pointer (no bytes yet). Fetched
// and uploaded to the PDS on publish (publishLocalRecipe).
async function storePendingImageSourceUrl(db: Kysely<DB>, recipeId: string, sourceUrl: string, alt: string | null): Promise<void> {
  await db
    .insertInto("recipe_pending_image")
    .values({ recipe_id: recipeId, object_key: null, mime: null, alt: alt ?? null, source_url: sourceUrl })
    .onConflict((oc) => oc.column("recipe_id").doUpdateSet({ object_key: null, mime: null, alt: alt ?? null, source_url: sourceUrl }))
    .execute();
}

// Fetch an imported hero image (SSRF-guarded, ≤1MB per the lexicon blob cap).
async function fetchImageFromUrl(url: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const { safeFetchBytes } = await import("#/lib/net/safe-fetch");
  try {
    const res = await safeFetchBytes(url, { maxBytes: 1_000_000 });
    const mime = res.contentType?.split(";")[0]?.trim() || "image/jpeg";
    if (!mime.startsWith("image/")) return null;
    return { bytes: res.bytes, mime };
  } catch {
    return null; // a missing hero shouldn't fail the whole publish.
  }
}

// Store a draft image in the bucket + a pointer row (draft path).
async function storePendingImage(db: Kysely<DB>, recipeId: string, image: RecipeImageInput): Promise<void> {
  const { putBlob } = await import("#/lib/blob-storage");
  const bytes = decodeBase64(image.dataBase64);
  if (bytes.byteLength > 1_000_000) throw new Error("Recipe image must be 1 MB or smaller.");
  const objectKey = `pending/${recipeId}`;
  await putBlob(objectKey, bytes, image.mime);
  await db
    .insertInto("recipe_pending_image")
    .values({ recipe_id: recipeId, object_key: objectKey, mime: image.mime, alt: image.alt ?? null, source_url: null })
    .onConflict((oc) => oc.column("recipe_id").doUpdateSet({ object_key: objectKey, mime: image.mime, alt: image.alt ?? null }))
    .execute();
}

// Publish a local recipe to the PDS and reconcile all local state.
async function publishLocalRecipe(db: Kysely<DB>, ctx: Ctx, recipeId: string, record: RecipeRecord, image: RecipeImageInput | null): Promise<void> {
  const { sql } = await import("kysely");
  const { createRecipe, uploadRecipeImage } = await import("#/lib/atproto/recipe-writes");
  const { getBlob, deleteBlob } = await import("#/lib/blob-storage");

  // Resolve image bytes: (a) the just-uploaded create-time image, (b) a pending
  // draft object already in the bucket, or (c) an imported hero we only have a
  // URL for — fetched now, SSRF-guarded (untested end-to-end: the publish path is
  // gated off by the kill switch in dev — see results doc).
  let imageBytes: Uint8Array | null = null;
  let imageMime: string | null = null;
  let imageAlt: string | null = null;
  let pendingKey: string | null = null;
  if (image) {
    imageBytes = decodeBase64(image.dataBase64);
    imageMime = image.mime;
    imageAlt = image.alt ?? null;
  } else {
    const pending = await db.selectFrom("recipe_pending_image").selectAll().where("recipe_id", "=", recipeId).executeTakeFirst();
    if (pending?.object_key) {
      imageBytes = await getBlob(pending.object_key);
      imageMime = pending.mime;
      imageAlt = pending.alt;
      pendingKey = pending.object_key;
    } else if (pending?.source_url) {
      const fetched = await fetchImageFromUrl(pending.source_url);
      if (fetched) {
        imageBytes = fetched.bytes;
        imageMime = fetched.mime;
        imageAlt = pending.alt;
      }
    }
  }

  // Build the record to publish (attach the blob embed if we have an image).
  let toPublish: Omit<RecipeRecord, "$type" | "createdAt" | "updatedAt"> & Partial<Pick<RecipeRecord, "createdAt" | "updatedAt">> = stripStamps(record);
  let imageBlobMeta: { cid: string; mime: string; size: number } | null = null;
  if (imageBytes && imageMime) {
    const blob = await uploadRecipeImage(ctx.did, imageBytes, imageMime);
    const ref = blob as { ref?: { $link?: string }; mimeType?: string; size?: number };
    imageBlobMeta = { cid: ref.ref?.$link ?? "", mime: ref.mimeType ?? imageMime, size: ref.size ?? imageBytes.byteLength };
    toPublish = {
      ...toPublish,
      embed: { $type: "exchange.recipe.recipe#imagesEmbed", images: [{ alt: imageAlt ?? "", image: blob as never }] } as RecipeRecord["embed"],
    };
  }

  // Write to the PDS, pinning the rkey to our ULID so recipe.id === rkey.
  const { uri, cid, rev } = await createRecipe(ctx.did, toPublish, recipeId);
  const publishedAt = new Date().toISOString();

  await db.transaction().execute(async (trx) => {
    await trx.updateTable("recipe").set({ visibility: "public", did: ctx.did, rkey: recipeId, uri, cid, rev, published_at: publishedAt }).where("id", "=", recipeId).execute();

    // Persist the published image as a rendered recipe_image row (renders via CDN).
    await trx.deleteFrom("recipe_image").where("recipe_id", "=", recipeId).execute();
    if (imageBlobMeta) {
      await trx
        .insertInto("recipe_image")
        .values({
          recipe_id: recipeId,
          ordinal: 0,
          alt: imageAlt,
          blob_cid: imageBlobMeta.cid,
          blob_mime: imageBlobMeta.mime,
          blob_size: imageBlobMeta.size,
          aspect_w: null,
          aspect_h: null,
        })
        .execute();
    }

    // Anti-dupe reconcile (plan §A2.8): seed the cron's bookkeeping so the next
    // sweep treats our record as already-synced. The raw row matches (did, rkey);
    // the rendered row already exists with id === rkey, so the cron's rev-guarded
    // upsert falls through to RECONCILE_LOCAL (cid/rev only) — never a duplicate.
    await trx
      .insertInto("atproto_repo")
      .values({ did: ctx.did })
      .onConflict((oc) => oc.column("did").doNothing())
      .execute();
    await trx
      .insertInto("atproto_collection_recipe")
      .values({
        did: ctx.did,
        rkey: recipeId,
        uri,
        cid,
        rev: rev ?? "",
        name: record.name,
        validation_status: "valid",
        record: JSON.stringify({ ...toPublish, $type: "exchange.recipe.recipe", createdAt: record.createdAt, updatedAt: record.updatedAt }),
        record_created_at: record.createdAt,
        record_updated_at: record.updatedAt,
      })
      .onConflict((oc) =>
        oc.columns(["did", "rkey"]).doUpdateSet({
          cid,
          rev: rev ?? "",
          uri,
          record: sql`excluded.record`,
        }),
      )
      .execute();

    // Clear the pending draft image pointer (bytes cleaned up after commit).
    await trx.deleteFrom("recipe_pending_image").where("recipe_id", "=", recipeId).execute();
  });

  if (pendingKey) await deleteBlob(pendingKey).catch(() => {});
}

// Rebuild the record + envelope facts from a stored local row (publish-later).
async function buildRecordFromRow(
  db: Kysely<DB>,
  ctx: Ctx,
  recipeId: string,
): Promise<{ record: RecipeRecordInput; uri: string | null; sourceUrl: string | null; pendingImage: RecipeImageInput | null } | null> {
  const { tokenForSlug } = await import("#/lib/recipe-vocab");
  // Ownership: the recipe must be boxed in the caller's active household.
  const row = await db
    .selectFrom("recipe as r")
    .innerJoin("household_recipe as hr", "hr.recipe_id", "r.id")
    .selectAll("r")
    .where("r.id", "=", recipeId)
    .where("hr.household_id", "=", ctx.householdId)
    .executeTakeFirst();
  if (!row) return null;

  const [ingredients, instructions, keywords, attribution] = await Promise.all([
    db.selectFrom("recipe_ingredient").select("text").where("recipe_id", "=", recipeId).orderBy("ordinal").execute(),
    db.selectFrom("recipe_instruction").select("text").where("recipe_id", "=", recipeId).orderBy("ordinal").execute(),
    db.selectFrom("recipe_keyword").select("keyword").where("recipe_id", "=", recipeId).execute(),
    db.selectFrom("recipe_attribution").selectAll().where("recipe_id", "=", recipeId).executeTakeFirst(),
  ]);

  const record: RecipeRecordInput = {
    name: row.name,
    text: row.description ?? "",
    ingredients: ingredients.map((r) => r.text),
    instructions: instructions.map((r) => r.text),
    keywords: keywords.length ? keywords.map((r) => r.keyword) : undefined,
    recipeYield: row.recipe_yield ?? undefined,
    prepTime: row.prep_time ?? undefined,
    cookTime: row.cook_time ?? undefined,
    totalTime: row.total_time ?? undefined,
    cookingMethod: (tokenForSlug("cooking_method", row.cooking_method) ?? undefined) as RecipeRecord["cookingMethod"],
    recipeCuisine: (tokenForSlug("cuisine", row.recipe_cuisine) ?? undefined) as RecipeRecord["recipeCuisine"],
    recipeCategory: (tokenForSlug("category", row.recipe_category) ?? undefined) as RecipeRecord["recipeCategory"],
    suitableForDiet: row.suitable_for_diet?.length ? (row.suitable_for_diet.map((s) => tokenForSlug("diet", s)).filter(Boolean) as RecipeRecord["suitableForDiet"]) : undefined,
    attribution: (attribution?.raw as RecipeRecord["attribution"]) ?? undefined,
    nutrition:
      row.calories != null || row.fat_content != null || row.protein_content != null || row.carbohydrate_content != null
        ? {
            calories: row.calories ?? undefined,
            fatContent: row.fat_content ?? undefined,
            proteinContent: row.protein_content ?? undefined,
            carbohydrateContent: row.carbohydrate_content ?? undefined,
          }
        : undefined,
  };

  const pendingRow = await db.selectFrom("recipe_pending_image").selectAll().where("recipe_id", "=", recipeId).executeTakeFirst();
  const pendingImage: RecipeImageInput | null = null; // bytes fetched from bucket at publish time, not here
  void pendingRow;

  const sourceUrl = attribution?.kind === "website" ? attribution.url : null;
  return { record, uri: row.uri, sourceUrl, pendingImage };
}

// --- small helpers -------------------------------------------------------

function stripStamps(record: RecipeRecord): Omit<RecipeRecord, "$type" | "createdAt" | "updatedAt"> & Partial<Pick<RecipeRecord, "createdAt" | "updatedAt">> {
  const { $type: _t, createdAt, updatedAt, ...rest } = record;
  void _t;
  return { ...rest, createdAt, updatedAt };
}

function mapDietSlugs(tokens: readonly string[] | undefined): string[] | null {
  if (!tokens?.length) return null;
  const slugs = tokens.map((t) => slugForToken("diet", t)).filter(Boolean) as string[];
  return slugs.length ? slugs : null;
}

function numOrNull(v: string | number | null | undefined): string | null {
  if (v == null) return null;
  const s = String(v);
  return s.length && !Number.isNaN(Number(s)) ? s : null;
}

function decodeBase64(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  return Uint8Array.from(Buffer.from(clean, "base64"));
}
