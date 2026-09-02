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

/**
 * A recipe's hero, as a save can refer to it — and there is only one way.
 *
 * The bytes are already in Buttery's bucket by the time a save mentions them:
 * the browser asked for a presigned URL and PUT them straight there
 * (`#/lib/recipe-image-upload`). All that crosses the wire here is the id of
 * that upload, which the server redeems against the *session's* own account.
 *
 * This used to be a three-armed union — a staged id, inline base64, or a
 * third-party URL for the server to go fetch itself. The last of those was the
 * losing fetcher: hotlink protection refuses a datacenter IP far more often than
 * it refuses a browser. Now there is one door. An image the browser could not
 * read is a recipe with no photo, never a recipe that borrows one.
 */
export interface RecipeImageInput {
  uploadId: string;
  alt?: string;
  /**
   * Where these bytes came from, when they came from somewhere — an imported
   * hero the browser fetched cross-origin, rather than a file the user picked.
   *
   * Recorded, never used. It is not an alternative to the upload and cannot
   * become one: `recipe_pending_image.object_key` is `not null`, so a row always
   * has our bytes behind it and no read path has a URL to fall back to. That is
   * the difference between this and the `source_url` column as it was, which was
   * a *substitute* for bytes and got rendered as an `<img src>` on our own page.
   */
  sourceUrl?: string | null;
}

export interface SaveRecipeInput {
  record: RecipeRecordInput;
  /** Where the draft lands. Publishing is a separate boolean, not a visibility. */
  visibility: "draft" | "private";
  publish: boolean;
  /** Set for imported recipes; locks Website attribution + drives dedupe. */
  sourceUrl?: string | null;
  image?: RecipeImageInput | null;
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

// --- normalization (mirror services/pipeline/src/workflows/atproto-sync/render.ts) ---

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

/**
 * Sign a form the browser can POST one recipe photo at, and hand back its id.
 *
 * The whole of Buttery's part in an upload. It authorizes (a session member), it
 * bounds (the declared mime must be on the allowlist, the declared size within
 * the 2 MB cap), and it derives the key from the session's DID so nothing a
 * client says can steer where the object lands. Then the browser talks to the
 * bucket and this service is out of the way — no body read, no re-upload, no
 * megabyte through our memory or egress.
 *
 * The bounds are not advisory, and the checks here are not what makes them so:
 * `presignUpload` writes them into the POST policy, so the *bucket* refuses an
 * over-sized body (`EntityTooLarge`), a re-typed one or a re-keyed one. The size
 * check below only saves a round trip for a file the browser already knows is
 * too big — a client that lies about it gets a form that will not accept the
 * bytes anyway.
 *
 * Nothing is written to the database here. An upload nobody saves is an orphan
 * under `uploads/`, which is what the prefix is for: ULIDs sort by time, so
 * expiring it is a bucket lifecycle rule rather than a sweeper we have to write.
 */
export const createRecipeImageUpload = createServerFn({ method: "POST" })
  .validator((data: { mime: string; size: number }) => ({ mime: String(data?.mime ?? ""), size: Number(data?.size ?? 0) }))
  .handler(async ({ data }): Promise<{ uploadId: string; url: string; fields: Record<string, string> } | null> => {
    const { activeContext } = await import("./recipe-context");
    const { assertMember } = await import("./authz");
    const { isAllowedImageMime, MAX_IMAGE_BYTES } = await import("#/lib/recipe-image");
    const { isBlobStorageConfigured, presignUpload, uploadKey } = await import("#/lib/blob-storage");
    const { ulid } = await import("./household/ids");

    // A signed URL is a write credential for shared infrastructure, so it is
    // gated like every other write here even though it touches no household
    // data: the key is derived from the DID alone.
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);

    if (!isBlobStorageConfigured()) return null;
    if (!isAllowedImageMime(data.mime)) return null;
    if (!Number.isInteger(data.size) || data.size <= 0 || data.size > MAX_IMAGE_BYTES) return null;

    const uploadId = ulid();
    return { uploadId, ...(await presignUpload(uploadKey(did, uploadId), data.mime)) };
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
  /**
   * The hero, as an id for bytes the browser already uploaded — never a URL.
   * Null when the caller owns the image pass itself: the batch import runs one
   * bounded, post-commit pass for a whole chunk rather than holding 25
   * row-locked transactions open across 25 bucket round trips (§11).
   */
  image?: RecipeImageInput | null;
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
  const ownsTransaction = !db.isTransaction;
  await insertLocalRecipe(db, ctx, recipeId, record, input.visibility, dedupeKeys);

  // Enqueue *after* insertLocalRecipe's transaction has committed — a job that
  // started before the commit landed would race it and find no recipe row to
  // read (§9). Best-effort: the `stale` row above is what actually matters.
  //
  // Only when THIS call owns the transaction, though: `db.isTransaction` is the
  // same flag `inTransaction()` (in `insertLocalRecipe`) reads to decide whether
  // to open a new transaction or reuse the caller's. When `db` arrives already
  // inside a transaction — the batch-import commit path hands in its own `trx`
  // (`recipe-import.ts`'s `commitImport`) — `insertLocalRecipe` writes into that
  // same open transaction, which has not committed by the time control returns
  // here. Enqueueing in that case would be the exact race this comment is about,
  // just one call further out: the caller is the only one who knows when ITS
  // commit actually lands, so the caller owns that enqueue. See
  // `runCommitImportChunk`'s post-commit pass for the batch-import side of this.
  if (ownsTransaction) {
    const { enqueueEnrich } = await import("./enrichment-queue");
    await enqueueEnrich(recipeId);
  }

  // 3. The hero: point the recipe at the object the browser uploaded, so a
  //    privately-saved import keeps its photo and the publish path has bytes to
  //    pipe to the PDS. A hero we cannot get is a recipe with no photo, never a
  //    recipe that borrows one.
  if (input.image) {
    await storeRecipeImage(db, ctx.did, recipeId, input.image, input.record.name);
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

  // 3. Validate + insert + dedupe keys + the hero. One image path for draft and
  //    publish alike: `persistRecipeDraft` always points the recipe at the
  //    object the browser uploaded, and step 5 reads it back from there.
  //    Publishing used to bypass the bucket and hand the create-time bytes
  //    straight to the PDS, which meant the two paths could disagree about what
  //    the image even was.
  const persisted = await persistRecipeDraft(db, ctx, {
    record: input.record,
    attribution,
    sourceUrl,
    image: input.image ?? null,
    visibility: input.visibility,
  });
  if (persisted.status === "invalid") return persisted;
  const { recipeId, record } = persisted;

  if (!input.publish) {
    return { status: "ok", recipeId, published: false };
  }

  // 4. Publish — gated by the atproto-publishing kill switch. If disabled, the
  //    draft above is kept and we return without any PDS write.
  const { isAtprotoPublishEnabled } = await import("#/lib/posthog-server");
  if (!(await isAtprotoPublishEnabled(ctx.did))) {
    return { status: "publish_disabled", recipeId };
  }

  // Pipe our stored bytes to the PDS as a blob (if the recipe has an image),
  // write the record with the ULID as rkey, then flip the row public +
  // reconcile the sync tables. An under-scoped grant leaves the draft intact
  // and asks the caller to re-authorize.
  const scopeErr = await publishOrScopeError(db, ctx, recipeId, record);
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
): Promise<{ status: "reauth_required"; recipeId: string; missingScope: string | null } | null> {
  const { AtprotoScopeError } = await import("#/lib/atproto/recipe-writes");
  try {
    await publishLocalRecipe(db, ctx, recipeId, record);
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

  // Stamp the record's timestamps before validating: `createdAt`/`updatedAt` are
  // required by the lexicon and are the server's to fill in (`recipe-record.ts`),
  // and `buildRecordFromRow` reads the *author's* columns only. Without this,
  // every publish of an existing draft fails validation with "Missing required
  // key createdAt" and nothing ever reaches a PDS. A draft has never had a
  // record, so its creation is either the frozen stamp from a previous life or
  // this moment.
  const stampedAt = new Date().toISOString();
  const validated = validateRecipeRecord({ ...built.record, $type: "exchange.recipe.recipe", createdAt: built.createdAt ?? stampedAt, updatedAt: stampedAt });
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

  const scopeErr = await publishOrScopeError(db, ctx, recipeId, validated.record);
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

    // Mark this recipe's enrichment stale in the same transaction as the recipe
    // itself (§9/D3) — the durable signal that the `enrich` step's fingerprint
    // check (§7.1 step 2) has something new to look at. `classifier_version` and
    // `input_hash` are deliberately left alone: they are what let an unchanged
    // re-save short-circuit back to `status='ok'` without running a classifier.
    // The best-effort enqueue happens after this transaction commits — see
    // `persistRecipeDraft`.
    await trx
      .insertInto("recipe_enrichment")
      .values({ recipe_id: id, status: "stale" })
      .onConflict((oc) => oc.column("recipe_id").doUpdateSet({ status: "stale" }))
      .execute();
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

// --- the pending hero ----------------------------------------------------
//
// A recipe image is an atproto blob on the author's own PDS (published) or an
// object in Buttery's bucket (everything before that). There is no third case:
// a URL on someone else's host is not a thing we store and not a thing we hand
// a browser as an `<img src>`. The three functions below are the whole of it —
// point a recipe at an upload, read it back for publish, drop it.

/**
 * Point a recipe at bytes the browser already uploaded.
 *
 * The object does not move. It landed at `uploads/<account>/<uploadId>` when the
 * browser PUT it there, and the row records that key — the previous design
 * copied it to `pending/<recipeId>` through this server's memory, which is a
 * megabyte of get-and-put to buy a key shape nothing reads.
 *
 * `did` is the session's, and the key is derived from it: the wire only ever
 * carries the id half, so one account cannot claim another's upload by guessing
 * an id (see `uploadKey`).
 *
 * The HEAD is not a formality. The browser reporting success is not evidence the
 * bucket agreed, and the bucket's `ContentType` is the type SigV4 actually bound
 * the upload to — so the row records what the bucket holds rather than what the
 * last request claimed. That is what replaced magic-byte sniffing: with the
 * bytes never passing through here there is nothing to sniff, and a signature is
 * a stronger promise than a header anyway.
 *
 * Returns whether an image ended up stored; every caller treats `false` as "this
 * recipe has no photo", never as an error, because the recipe row is already
 * committed by the time this runs and a dead hero must not take it down.
 *
 * Exported for the batch import commit path (§11): it runs this as a bounded,
 * **post-commit** pass rather than letting `persistRecipeDraft` do it inline, so
 * a chunk of 25 never holds 25 row-locked transactions open across 25 bucket
 * round trips. Same function either way — one image path, one guard, one cap.
 */
export async function storeRecipeImage(db: Kysely<DB>, did: string, recipeId: string, image: RecipeImageInput, alt: string | null): Promise<boolean> {
  const { isAllowedImageMime, isValidUploadId } = await import("#/lib/recipe-image");
  const { deleteBlob, headBlob, uploadKey } = await import("#/lib/blob-storage");
  if (!isValidUploadId(image.uploadId)) return false;

  const objectKey = uploadKey(did, image.uploadId);
  const head = await headBlob(objectKey);
  if (!head || !isAllowedImageMime(head.mime)) return false;

  const row = { object_key: objectKey, mime: head.mime, alt: image.alt ?? alt ?? null, source_url: image.sourceUrl ?? null };
  const previous = await db.selectFrom("recipe_pending_image").select("object_key").where("recipe_id", "=", recipeId).executeTakeFirst();
  await db
    .insertInto("recipe_pending_image")
    .values({ recipe_id: recipeId, ...row })
    .onConflict((oc) => oc.column("recipe_id").doUpdateSet(row))
    .execute();

  // The replaced object has no reader left. Best-effort and *after* the row
  // moves: an orphan costs storage, deleting first and failing to write loses a
  // photo the user still has.
  if (previous && previous.object_key !== objectKey) await deleteBlob(previous.object_key).catch(() => {});
  return true;
}

/**
 * The bytes behind a recipe's pending hero, or null if it has none.
 *
 * The one place a recipe image passes through this server, and it exists for the
 * one hop a browser cannot make: publish, which uploads them to the author's PDS
 * as a blob. Everything that merely *renders* the image gets a signed URL and
 * reads it off the bucket directly.
 */
async function readPendingImage(db: Kysely<DB>, recipeId: string): Promise<{ bytes: Uint8Array; mime: string; alt: string | null } | null> {
  const row = await db.selectFrom("recipe_pending_image").select(["object_key", "mime", "alt"]).where("recipe_id", "=", recipeId).executeTakeFirst();
  if (!row) return null;
  const { getBlob } = await import("#/lib/blob-storage");
  try {
    return { bytes: await getBlob(row.object_key), mime: row.mime, alt: row.alt };
  } catch {
    // The row promised an object that is not there. Nothing to publish; the
    // caller treats it as "no image".
    return null;
  }
}

/** Drop a recipe's pending hero — pointer row first, then the bytes. */
async function clearPendingImage(db: Kysely<DB>, recipeId: string): Promise<void> {
  const { deleteBlob } = await import("#/lib/blob-storage");
  const row = await db.selectFrom("recipe_pending_image").select("object_key").where("recipe_id", "=", recipeId).executeTakeFirst();
  await db.deleteFrom("recipe_pending_image").where("recipe_id", "=", recipeId).execute();
  if (row) await deleteBlob(row.object_key).catch(() => {});
}

/**
 * Publish a local recipe to the PDS and reconcile all local state.
 *
 * The image half is one sentence long: **our bytes go to the PDS.** There is no
 * create-time byte path and no fetch-from-the-origin path here — both existed,
 * and between them the record that reached a user's repo could be built from
 * bytes nothing had ever stored. The recipe already points at one object
 * (`storeRecipeImage`), so publish reads that, uploads it as a blob, and deletes
 * it once the record is written.
 */
async function publishLocalRecipe(db: Kysely<DB>, ctx: Ctx, recipeId: string, record: RecipeRecord): Promise<void> {
  const { sql } = await import("kysely");
  const { createRecipe, uploadRecipeImage } = await import("#/lib/atproto/recipe-writes");

  const pending = await readPendingImage(db, recipeId);
  const imageAlt = pending?.alt ?? null;

  // Build the record to publish (attach the blob embed if we have an image).
  let toPublish: Omit<RecipeRecord, "$type" | "createdAt" | "updatedAt"> & Partial<Pick<RecipeRecord, "createdAt" | "updatedAt">> = stripStamps(record);
  let imageBlobMeta: { cid: string; mime: string; size: number } | null = null;
  if (pending) {
    const blob = await uploadRecipeImage(ctx.did, pending.bytes, pending.mime);
    const ref = blob as { ref?: { $link?: string }; mimeType?: string; size?: number };
    imageBlobMeta = { cid: ref.ref?.$link ?? "", mime: ref.mimeType ?? pending.mime, size: ref.size ?? pending.bytes.byteLength };
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

    // Mark stale in the same transaction as the publish (§9/D3), same as
    // insertLocalRecipe. Publishing never changes name or ingredients, so the
    // fingerprint the `enrich` step compares against will still match and it
    // will return `{status:"unchanged"}` without running a classifier — but
    // marking stale here is still correct, and cheap enough not to special-case.
    await trx
      .insertInto("recipe_enrichment")
      .values({ recipe_id: recipeId, status: "stale" })
      .onConflict((oc) => oc.column("recipe_id").doUpdateSet({ status: "stale" }))
      .execute();
  });

  // Enqueue *after* the transaction above has committed, same reasoning as
  // persistRecipeDraft — a job that started mid-transaction could read a
  // recipe still mid-publish.
  const { enqueueEnrich } = await import("./enrichment-queue");
  await enqueueEnrich(recipeId);

  // The image now lives on the PDS as a blob and renders from an atproto CDN
  // (`recipe_image` above); our pre-publish copy has no reader left. Dropped
  // after the transaction commits, and best-effort: an orphan object costs
  // storage, whereas clearing it inside the transaction would delete bytes a
  // rollback still needed.
  await clearPendingImage(db, recipeId);
}

// Rebuild the record + envelope facts from a stored local row (publish-later).
async function buildRecordFromRow(
  db: Kysely<DB>,
  ctx: Ctx,
  recipeId: string,
): Promise<{ record: RecipeRecordInput; createdAt: string | null; uri: string | null; sourceUrl: string | null } | null> {
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

  // No image lookup here on purpose: publishing reads the object the recipe
  // already points at (`publishLocalRecipe`), which is the only place that needs
  // the bytes and the only place that should know where they live.

  const sourceUrl = attribution?.kind === "website" ? attribution.url : null;
  // The record's frozen `createdAt` if this row ever carried one, else when the
  // local row came into being. Never `now` here — the caller decides that, and
  // only when there is nothing truer to use.
  const createdAt = (row.record_created_at ?? row.indexed_at)?.toISOString() ?? null;
  return { record, createdAt, uri: row.uri, sourceUrl };
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
