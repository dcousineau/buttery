import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import dayjs from "dayjs";
import duration from "dayjs/plugin/duration.js";
import type { Main as RecipeRecord } from "@buttery/lexicons/exchange/recipe/recipe";
import { validateRecipeRecord } from "#/lib/recipe-record";
import type { FieldIssue, RecipeRecordInput } from "#/lib/recipe-record";
import { labelForSlug, slugForToken, tokenForSlug } from "#/lib/recipe-vocab";

dayjs.extend(duration);

// Local recipe authoring: save a draft to the household box and/or publish it to
// the author's atproto PDS. The wire contract is the exchange.recipe.recipe
// record shape (minus the server-stamped $type/timestamps) wrapped in a thin
// Buttery envelope. See docs/plans/2026-08-02-create-recipes.md §A2.
//
// Server-only deps (db, blob storage, atproto client) are pulled in via dynamic
// import() inside the handlers so this module stays out of the client bundle.
// This applies to the exported helpers too: `persistRecipeDraft` takes `db` as a
// parameter and reaches everything else (`ulid`, `recipe-meta`, the normalizers)
// through dynamic import, so importing it costs a client bundle nothing.
//
// `persistRecipeDraft` is the shared persistence core: `saveRecipe` and the batch
// import commit path both go through it, so a recipe is written exactly one way
// (docs/plans/2026-08-09-paprika-import.md §2.4, §7.3). It validates, inserts and
// writes the dedupe keys; it never checks for duplicates and never publishes.

// The record shape and the lexicon gate live in `#/lib/recipe-record` so the import review
// screen can predict this module's verdict with the *same* schema instead of a second copy
// of the length caps. Re-exported here because this module is still their public address.
export type { FieldIssue, RecipeRecordInput };
import type { AttributionChoice } from "#/lib/api/types";

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

export type SaveRecipeResult =
  | { status: "ok"; recipeId: string; published: boolean }
  | { status: "invalid"; issues: FieldIssue[] }
  | { status: "duplicate"; existingRecipeId: string }
  // Publishing is turned off by the atproto-publishing kill switch. Any draft was
  // still saved; `recipeId` points at it so the caller can land on the draft.
  | { status: "publish_disabled"; recipeId: string }
  // The signed-in account's atproto grant predates the scopes publishing needs
  // (see ATPROTO_SCOPE). The draft is saved; the caller must send the user back
  // through authorization before the PDS write can succeed.
  | { status: "reauth_required"; recipeId: string; missingScope: string | null };

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
 * What a human said a URL-less recipe came from, before it is a lexicon
 * attribution. The three shapes are the three answerable choices from the
 * import review screen's bulk classification step (§8.1) — "skip these" is the
 * fourth choice there and never reaches the server.
 *
 * This exists so the one place that turns free text into an attribution is
 * `resolveAttribution`, shared by the create form and the import commit path.
 * Duplicating it in the importer is how the two drift: §8.2 forbids inventing
 * an author from a title or a name from a page reference, and that rule is only
 * enforceable if there is a single implementation of it.
 */
export type { AttributionChoice };

/** Build a lexicon attribution from a user's classification, or null if the choice is incomplete. */
function attributionFromChoice(choice: AttributionChoice): RecipeRecord["attribution"] | null {
  const trim = (v: string | undefined): string => (typeof v === "string" ? v.trim() : "");
  switch (choice.kind) {
    case "publication": {
      const title = trim(choice.title);
      const author = trim(choice.author);
      // Both are lexicon-required. Never fabricate one from the other (§8.2).
      if (!title || !author) return null;
      return { $type: "exchange.recipe.defs#attributionPublication", title, author };
    }
    case "person": {
      const name = trim(choice.name);
      if (!name) return null;
      return { $type: "exchange.recipe.defs#attributionPerson", name };
    }
    case "website": {
      const url = trim(choice.url);
      const name = trim(choice.name) || domainOf(url) || url;
      if (!url || !name) return null;
      return { $type: "exchange.recipe.defs#attributionWebsite", name, url } as RecipeRecord["attribution"];
    }
  }
}

/**
 * Enforce Buttery's non-negotiable attribution rule (the lexicon marks it
 * optional; we don't). For imported recipes, re-derive a Website attribution
 * server-side from the source URL — the client's attribution is never trusted
 * when `sourceUrl` is present. Failing that, a caller may hand in an explicit
 * free-text classification (§8.1); failing that, the record must already carry
 * a lexicon attribution. Returns the attribution object, or null if the caller
 * must be rejected.
 */
export function resolveAttribution(record: RecipeRecordInput, sourceUrl: string | null, choice?: AttributionChoice | null): RecipeRecord["attribution"] | null {
  if (sourceUrl) {
    const name = domainOf(sourceUrl);
    return {
      $type: "exchange.recipe.defs#attributionWebsite",
      url: sourceUrl,
      name: name ?? sourceUrl,
    } as RecipeRecord["attribution"];
  }
  if (choice) return attributionFromChoice(choice);
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

import type { Kysely, Sql } from "kysely";
import type { DB } from "#/db/types";

interface Ctx {
  did: string;
  householdId: string;
}

// --- persistRecipeDraft: the shared persistence core (§7.3) --------------

/** Namespace the dedupe keys live under in `recipe_meta` (§5.1, §6). */
export const DEDUPE_NS = "dedupe";

/**
 * The two dedupe keys (§6). `sourceUrlKey` is null when the recipe has no
 * usable source URL — 24% of the reference corpus — which is exactly why
 * `contentFp` is not optional.
 */
export interface DedupeKeys {
  sourceUrlKey: string | null;
  contentFp: string;
}

/**
 * Derive both dedupe keys from a recipe's own content.
 *
 * **Always computed from the submitted record, never accepted from a caller**
 * (§6.1, §7.3). The import review screen lets a user rename a recipe and edit
 * its ingredients *after* the duplicate probe ran, so a key computed anywhere
 * but here describes a recipe that was never saved.
 */
export async function computeDedupeKeys(recipe: { name: string; ingredients?: readonly string[] }, sourceUrl: string | null): Promise<DedupeKeys> {
  const { normalizeSourceUrl, contentFingerprint } = await import("@buttery/recipe-schemas/normalize");
  return {
    sourceUrlKey: normalizeSourceUrl(sourceUrl),
    contentFp: await contentFingerprint(recipe.name, recipe.ingredients ?? []),
  };
}

export interface PersistRecipeDraftInput {
  record: RecipeRecordInput;
  /**
   * Already resolved by the caller via `resolveAttribution` — this function
   * enforces no attribution rule of its own, it just stamps what it is given
   * onto the record before the lexicon gate.
   */
  attribution: RecipeRecord["attribution"];
  /** Provenance. Used only to derive `source_url_key`; attribution was the caller's job. */
  sourceUrl: string | null;
  /** A cross-origin hero we only have a URL for. Fetched here (SSRF-guarded) if set. */
  imageSourceUrl?: string | null;
  visibility: "draft" | "private";
}

export type PersistRecipeDraftResult =
  /**
   * `record` is the exact validated, server-stamped record that was written.
   * `saveRecipe` publishes *that* object rather than re-assembling one, so the
   * `createdAt`/`updatedAt` on the PDS match the row byte for byte. The import
   * path never publishes (§7.4) and can ignore it.
   */
  { status: "ok"; recipeId: string; record: RecipeRecord } | { status: "invalid"; issues: FieldIssue[] };

/**
 * Persist one new local recipe — the reusable middle of `saveRecipe`, shared
 * verbatim with the batch import commit path (§7.3, §2.4). Validate → insert →
 * dedupe keys → pending image, and nothing else.
 *
 * Deliberately absent, both by contract:
 *
 * - **No dedupe check.** The two callers check different corpora — `saveRecipe`
 *   probes the public atproto index only when publishing, the import path
 *   probes this household's box — so neither belongs in here.
 * - **No publish.** Publishing is irreversible and attributed; keeping it out
 *   is what makes it structurally impossible for a 341-recipe batch to reach a
 *   PDS (§2.1, §7.4).
 *
 * `db` is a parameter rather than a module-level import so a caller can hand in
 * its own open transaction (the import path commits a chunk atomically) — and
 * so this function needs no dynamic `import()` of `#/lib/db` to stay out of the
 * client bundle.
 */
export const persistRecipeDraft = createServerOnlyFn(async (db: Kysely<DB>, ctx: Ctx, input: PersistRecipeDraftInput): Promise<PersistRecipeDraftResult> => {
  const { ulid } = await import("./household/ids");

  // 1. Assemble the full record + lexicon validation gate.
  const now = new Date().toISOString();
  const full = {
    $type: "exchange.recipe.recipe",
    ...input.record,
    attribution: input.attribution,
    createdAt: now,
    updatedAt: now,
  };
  const validated = validateRecipeRecord(full);
  if (validated.status === "invalid") return { status: "invalid", issues: validated.issues };
  const record = validated.record;

  // 2. Mint the stable ULID id, then write the local rows AND the dedupe keys
  //    in one transaction — a recipe must never exist without its keys, or it
  //    is invisible to every future dedupe pass (§6.6).
  const recipeId = ulid();
  const dedupeKeys = await computeDedupeKeys(record, input.sourceUrl);
  await insertLocalRecipe(db, ctx, recipeId, record, input.visibility, dedupeKeys);

  // 3. Imported hero we only have a cross-origin URL for. Fetch it now
  //    (SSRF-guarded, ≤1MB) and store it in the bucket like an uploaded image so
  //    a privately-saved import keeps its photo. Falls back to a URL-only
  //    pointer (fetched at publish) if the fetch fails.
  if (input.imageSourceUrl) {
    await storePendingImageFromUrl(db, recipeId, input.imageSourceUrl, input.record.name);
  }

  return { status: "ok", recipeId, record };
});

const runSave = createServerOnlyFn(async (db: Kysely<DB>, ctx: Ctx, input: SaveRecipeInput): Promise<SaveRecipeResult> => {
  const { sql } = await import("kysely");

  const sourceUrl = input.sourceUrl?.trim() || null;

  // 1. Attribution enforcement (imported → server-built Website; else required).
  const attribution = resolveAttribution(input.record, sourceUrl);
  if (!attribution) {
    return { status: "invalid", issues: [{ path: "attribution", message: "Choose where this recipe came from." }] };
  }

  // 2. Dedupe (publish + import only): block a URL an existing PUBLIC record cites.
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

  // 3. Validate + insert + dedupe keys + imported hero. An uploaded image
  //    (bytes on the wire) suppresses the URL hero exactly as before.
  const persisted = await persistRecipeDraft(db, ctx, {
    record: input.record,
    attribution,
    sourceUrl,
    imageSourceUrl: input.image ? null : input.imageSourceUrl,
    visibility: input.visibility,
  });
  if (persisted.status === "invalid") return persisted;
  const { recipeId, record } = persisted;

  // 4. Uploaded image → bucket + pointer row (draft path). On the publish path
  //    we upload the blob directly instead (below), so skip the pending row.
  if (input.image && !input.publish) {
    await storePendingImage(db, recipeId, input.image);
  }

  if (!input.publish) {
    return { status: "ok", recipeId, published: false };
  }

  // 5. Publish — gated by the atproto-publishing kill switch. If disabled, the
  //    draft above is kept and we return without any PDS write.
  const { isAtprotoPublishEnabled } = await import("#/lib/posthog-server");
  if (!(await isAtprotoPublishEnabled(ctx.did))) {
    return { status: "publish_disabled", recipeId };
  }

  // Upload image blob (if any), write the record to the PDS with the ULID as
  // rkey, then flip the row public + reconcile the sync tables. An under-scoped
  // grant leaves the draft intact and asks the caller to re-authorize.
  const scopeErr = await publishOrScopeError(db, ctx, recipeId, record, input.image ?? null);
  if (scopeErr) return scopeErr;
  return { status: "ok", recipeId, published: true };
});

/**
 * Run the PDS publish, translating an under-scoped atproto grant into a
 * `reauth_required` result. Any other failure propagates — publishing is
 * all-or-nothing and a real error should surface as one.
 */
async function publishOrScopeError(
  db: Kysely<DB>,
  ctx: Ctx,
  recipeId: string,
  record: RecipeRecord,
  image: RecipeImageInput | null,
): Promise<{ status: "reauth_required"; recipeId: string; missingScope: string | null } | null> {
  const { AtprotoScopeError } = await import("#/lib/atproto/recipe-writes");
  try {
    await publishLocalRecipe(db, ctx, recipeId, record, image);
    return null;
  } catch (err) {
    if (err instanceof AtprotoScopeError) {
      return { status: "reauth_required", recipeId, missingScope: err.missingScope };
    }
    throw err;
  }
}

const runPublishExisting = createServerOnlyFn(async (db: Kysely<DB>, ctx: Ctx, recipeId: string): Promise<SaveRecipeResult> => {
  if (!recipeId) return { status: "invalid", issues: [{ path: "recipeId", message: "Missing recipe." }] };

  // Load the caller's own draft and rebuild the record for the PDS write.
  const built = await buildRecordFromRow(db, ctx, recipeId);
  if (!built) return { status: "invalid", issues: [{ path: "recipeId", message: "Draft not found." }] };
  if (built.uri) return { status: "ok", recipeId, published: true }; // already public

  const validated = validateRecipeRecord({ ...built.record, $type: "exchange.recipe.recipe" });
  if (validated.status === "invalid") return { status: "invalid", issues: validated.issues };

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

  const scopeErr = await publishOrScopeError(db, ctx, recipeId, validated.record, built.pendingImage);
  if (scopeErr) return scopeErr;
  return { status: "ok", recipeId, published: true };
});

/**
 * Run `fn` in a transaction, reusing the caller's if there already is one.
 *
 * `Transaction#transaction()` throws in Kysely, so a helper that unconditionally
 * opens one cannot be called from inside a caller's transaction — and the import
 * commit path needs exactly that, to make a chunk atomic.
 */
async function inTransaction<T>(db: Kysely<DB>, fn: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
  if (db.isTransaction) return await fn(db);
  return await db.transaction().execute(fn);
}

// Insert the recipe + all child rows for a new local (unpublished) recipe,
// plus its dedupe keys — one transaction, so a recipe cannot exist without the
// keys that make it findable by every later dedupe pass (§6.6).
async function insertLocalRecipe(db: Kysely<DB>, ctx: Ctx, id: string, record: RecipeRecord, visibility: "draft" | "private", dedupeKeys: DedupeKeys): Promise<void> {
  const { sql } = await import("kysely");
  const { setRecipeMeta } = await import("./recipe-meta");
  await inTransaction(db, async (trx) => {
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

    // Dedupe sidecar (§6). A recipe with no usable source URL simply has no
    // `source_url_key` row — an absent key and a null key are the same thing to
    // every reader, and writing null would make the value index carry noise.
    // NEVER published; `recipe_meta` is Buttery-only (§2.3).
    await setRecipeMeta(trx, id, DEDUPE_NS, {
      content_fp: dedupeKeys.contentFp,
      ...(dedupeKeys.sourceUrlKey ? { source_url_key: dedupeKeys.sourceUrlKey } : {}),
    });
  });
}

// Re-derive the child rows (ingredient/instruction/keyword/attribution/image/
// search) for a recipe. Delete-then-insert so it works for update too.
async function writeChildren(trx: Kysely<DB>, id: string, record: RecipeRecord, sql: Sql): Promise<void> {
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

/**
 * Fetch an imported hero now and store it in the bucket (draft path), so a
 * privately-saved import keeps its photo instead of waiting for publish. Keeps
 * `source_url` alongside `object_key` for provenance; publish prefers the bucket
 * bytes. Falls back to a URL-only pointer if the fetch fails (retried at publish).
 *
 * Exported for the batch import commit path (§11): it runs this as a bounded,
 * **post-commit** pass rather than letting `persistRecipeDraft` do it inline, so
 * a chunk of 25 never holds 25 row-locked transactions open across 25 outbound
 * fetches. Same function either way — one image path, one SSRF guard, one cap.
 */
export async function storePendingImageFromUrl(db: Kysely<DB>, recipeId: string, sourceUrl: string, alt: string | null): Promise<void> {
  const fetched = await fetchImageFromUrl(sourceUrl);
  if (!fetched) {
    await storePendingImageSourceUrl(db, recipeId, sourceUrl, alt);
    return;
  }
  const { putBlob } = await import("#/lib/blob-storage");
  const objectKey = `pending/${recipeId}`;
  await putBlob(objectKey, fetched.bytes, fetched.mime);
  await db
    .insertInto("recipe_pending_image")
    .values({ recipe_id: recipeId, object_key: objectKey, mime: fetched.mime, alt: alt ?? null, source_url: sourceUrl })
    .onConflict((oc) => oc.column("recipe_id").doUpdateSet({ object_key: objectKey, mime: fetched.mime, alt: alt ?? null, source_url: sourceUrl }))
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
const fetchImageFromUrl = createServerOnlyFn(async (url: string): Promise<{ bytes: Uint8Array; mime: string } | null> => {
  const { safeFetchBytes } = await import("#/lib/net/safe-fetch");
  try {
    const res = await safeFetchBytes(url, { maxBytes: 1_000_000 });
    const mime = res.contentType?.split(";")[0]?.trim() || "image/jpeg";
    if (!mime.startsWith("image/")) return null;
    return { bytes: res.bytes, mime };
  } catch {
    return null; // a missing hero shouldn't fail the whole publish.
  }
});

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
      embed: { $type: "exchange.recipe.recipe#imagesEmbed", images: [{ alt: imageAlt ?? "", image: blob }] },
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
    cookingMethod: tokenForSlug("cooking_method", row.cooking_method) ?? undefined,
    recipeCuisine: tokenForSlug("cuisine", row.recipe_cuisine) ?? undefined,
    recipeCategory: tokenForSlug("category", row.recipe_category) ?? undefined,
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
