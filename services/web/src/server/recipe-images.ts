import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "#/db/types";

/**
 * The one door every recipe image goes through.
 *
 * **The invariant:** a recipe image is either an atproto blob (the user's own
 * bytes, on their own PDS, served by an atproto CDN — see lib/atproto/images.ts)
 * or an object in Buttery's own bucket. There is no third case. A URL on
 * someone else's host is a place we may *read* bytes from once; it is never a
 * thing we store, and never a thing we hand to a browser as an `<img src>`.
 *
 * That used to be a convention spread across three call sites, and it drifted:
 * `recipe_pending_image` carried a `source_url` column that the read path
 * rendered directly (a hotlinked third-party URL on our recipe page), that the
 * publish path re-fetched from, and that a folder import populated for every
 * hero it could not reach. The column is gone; `object_key` is `not null`. The
 * class of bug is now unrepresentable rather than forbidden by comment.
 *
 * Bytes reach here two ways, in this order of preference:
 *
 *   1. **The browser** — `POST /api/recipe-image/staged` (routes/api/recipe-image/).
 *      The tab either already holds the bytes (a folder import reads photos
 *      straight off the dropped `File`s; the create form's file picker) or can
 *      fetch them with the user's own referer and cookies. It PUTs them to a
 *      `staged/<account>/<ulid>` key and hands the commit an opaque upload id.
 *   2. **The server** — {@link storePendingImageFromUrl}, an SSRF-guarded,
 *      size-capped fetch, used as the fallback for a host that refuses the
 *      browser (no CORS headers, typically). It can itself be refused —
 *      hotlink protection keys on Referer, and a datacenter IP is an easy
 *      block — which is exactly why the browser goes first.
 *
 * When both fail the recipe simply has no image. That is the deliberate cost of
 * the invariant: a missing photo, never a borrowed one.
 */

/** The lexicon's blob cap (`exchange.recipe.recipe` embed: `image/*`, maxSize 1000000). */
export const MAX_IMAGE_BYTES = 1_000_000;

export interface PendingImageBytes {
  bytes: Uint8Array;
  mime: string;
  alt: string | null;
}

// --- keys ----------------------------------------------------------------

/**
 * Where a claimed image lives: one object per recipe, overwritten in place.
 *
 * Keyed by recipe id (a ULID we mint) rather than anything user-supplied, so
 * the key space cannot be steered by a caller and a re-save cannot orphan the
 * previous object.
 */
export function pendingImageKey(recipeId: string): string {
  return `pending/${recipeId}`;
}

/**
 * Whether a recipe id is safe to put in an object key verbatim.
 *
 * A local recipe's id is a ULID this server minted, which is Crockford base32
 * and always safe. A *synced* recipe's id is an atproto rkey, which may contain
 * `:` — and a `:` in a key breaks the SigV4 signature outright (see
 * {@link stagedImageKey}). No synced recipe has a pending image today (only
 * `persistRecipeDraft` writes one, and it mints the id), so this is a guard on
 * an invariant rather than a case that is reached: it turns a future caller's
 * mistake into a refusal here instead of an `AccessDenied` from the bucket.
 */
export function isKeySafeRecipeId(recipeId: string): boolean {
  return /^[A-Za-z0-9._-]{1,256}$/.test(recipeId);
}

/**
 * Where a browser upload lands before it has a recipe to belong to.
 *
 * The account is part of the key and the caller only ever hands back the
 * `uploadId` half, so the server reconstructs the full key from the *session's*
 * DID: one account cannot claim another account's staged bytes by guessing an
 * id. The `staged/` prefix is also the handle for a bucket lifecycle rule — an
 * upload whose commit never arrived is garbage, and ULIDs sort by time, so
 * expiring the prefix is the cleanup story.
 *
 * The account is a HASH of the DID, not the DID, for two independent reasons
 * and either would be enough:
 *
 *   1. A DID contains colons (`did:plc:abc`), and a `:` in an object key is not
 *      portable. The AWS SDK and `local-s3` disagree on whether SigV4's
 *      canonical URI percent-encodes it, so every such request fails the
 *      signature check — surfaced, unhelpfully, as `AccessDenied`. (`%` fails
 *      the same way, so escaping is not the fix.) Verified by probing four keys
 *      through one client: only the ones with `:` or `%` failed.
 *   2. Object keys are readable to anything that can list the bucket, and a raw
 *      DID is a user identifier. Hashing keeps the account partition without
 *      publishing who each partition belongs to.
 *
 * Plain SHA-256, hex: this is a namespace derivation, not a credential — there
 * is nothing to brute-force here that knowing the DID would not already give
 * you, and it has to be reproducible from the session alone with nothing stored.
 */
export function stagedImageKey(did: string, uploadId: string): string {
  return `staged/${accountSlug(did)}/${uploadId}`;
}

/** Hex SHA-256 of a DID — a stable, key-safe stand-in for it. */
export function accountSlug(did: string): string {
  return createHash("sha256").update(did).digest("hex");
}

/**
 * Upload ids are minted by {@link mintUploadId} and travel through a browser,
 * so they are validated on the way back in rather than trusted: they land in an
 * object key, and a key with a `/` or a `..` in it is a path-traversal in the
 * bucket's namespace.
 */
export function isValidUploadId(uploadId: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(uploadId);
}

// --- content sniffing ----------------------------------------------------

/**
 * The image types we accept, by magic bytes.
 *
 * Sniffed rather than believed: `Content-Type` on an upload is attacker-chosen
 * and on a third-party fetch is frequently just wrong (`application/octet-stream`
 * from a misconfigured CDN, `text/html` from an interstitial). The sniffed type
 * is what we store, what the proxy route serves, and what goes to the PDS as
 * the blob's `encoding` — so a mislabelled byte string cannot become an
 * `image/svg+xml` we serve back to a browser from our own origin.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  // RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  // ISO-BMFF brands: ....ftyp<brand>
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand.startsWith("hei") || brand.startsWith("mif")) return "image/heic";
  }
  return null;
}

/**
 * Gate incoming bytes: real image, within the lexicon's cap.
 *
 * Returns the *sniffed* mime, never the caller's claim. `null` means "not
 * something we will store", and every caller treats that as "this recipe has no
 * image" rather than as an error — a bad hero must never fail a save.
 */
export function validateImageBytes(bytes: Uint8Array): { bytes: Uint8Array; mime: string } | null {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;
  const mime = sniffImageMime(bytes);
  if (!mime) return null;
  return { bytes, mime };
}

// --- writes --------------------------------------------------------------

/**
 * Put bytes in the bucket and point the recipe at them.
 *
 * The pointer row is written only after the object lands, so a row can never
 * name a key that holds nothing — the publish path reads `object_key`
 * unconditionally and a dangling pointer would be a failed publish rather than
 * a missing photo.
 */
export async function storePendingImageBytes(db: Kysely<DB>, recipeId: string, image: { bytes: Uint8Array; mime: string; alt: string | null }): Promise<boolean> {
  if (!isKeySafeRecipeId(recipeId)) return false;
  const { putBlob } = await import("#/lib/blob-storage");
  const objectKey = pendingImageKey(recipeId);
  await putBlob(objectKey, image.bytes, image.mime);
  await db
    .insertInto("recipe_pending_image")
    .values({ recipe_id: recipeId, object_key: objectKey, mime: image.mime, alt: image.alt })
    .onConflict((oc) => oc.column("recipe_id").doUpdateSet({ object_key: objectKey, mime: image.mime, alt: image.alt }))
    .execute();
  return true;
}

/**
 * Claim a browser upload for a recipe: `staged/<did>/<id>` → `pending/<recipeId>`.
 *
 * `did` comes from the session, never from the wire (see {@link stagedImageKey}).
 * A missing or unreadable staged object returns `false` rather than throwing:
 * the recipe is already saved by the time this runs, and losing its photo must
 * not lose it. The caller may then fall back to the server-side fetch.
 */
export async function claimStagedImage(db: Kysely<DB>, did: string, recipeId: string, uploadId: string, alt: string | null): Promise<boolean> {
  if (!isValidUploadId(uploadId)) return false;
  const { getBlob, deleteBlob } = await import("#/lib/blob-storage");
  const from = stagedImageKey(did, uploadId);
  let image: { bytes: Uint8Array; mime: string } | null;
  try {
    // Re-validated here rather than trusted from the upload route: the sniffed
    // mime is what the PDS blob will be encoded as and what the proxy route
    // serves, so it is derived once, from the bytes we actually kept.
    image = validateImageBytes(await getBlob(from));
  } catch {
    return false;
  }
  if (!image) return false;
  await storePendingImageBytes(db, recipeId, { ...image, alt });
  // Only after the pending copy exists: an orphan under `staged/` is garbage a
  // lifecycle rule collects, while deleting first and failing to write would
  // lose an image the user just handed us.
  await deleteBlob(from).catch(() => {});
  return true;
}

/**
 * The server-side fallback: fetch a third-party image URL and store OUR copy.
 *
 * The URL is an argument, not a record. Nothing about it is persisted — on
 * success the recipe points at our object, on failure the recipe has no image
 * and the URL is forgotten. Both outcomes are `boolean`, neither is an error:
 * this runs after the recipe row is committed (the batch import's post-commit
 * pass, `persistRecipeDraft`'s tail) and a dead hero must never take a saved
 * recipe with it.
 */
export async function storePendingImageFromUrl(db: Kysely<DB>, recipeId: string, sourceUrl: string, alt: string | null): Promise<boolean> {
  const fetched = await fetchImageFromUrl(sourceUrl);
  if (!fetched) return false;
  return await storePendingImageBytes(db, recipeId, { ...fetched, alt });
}

/**
 * SSRF-guarded, size-capped fetch of a user-supplied image URL.
 *
 * Exported for the publish path's read-back and for tests. Returns the sniffed
 * mime; a response that is not actually an image (an HTML "hotlinking not
 * allowed" page served with a 200, which is common) is `null`, not a stored
 * object.
 */
export async function fetchImageFromUrl(url: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const { safeFetchBytes } = await import("#/lib/net/safe-fetch");
  try {
    const res = await safeFetchBytes(url, { maxBytes: MAX_IMAGE_BYTES });
    return validateImageBytes(res.bytes);
  } catch {
    return null;
  }
}

// --- reads ---------------------------------------------------------------

/**
 * The bytes behind a recipe's pending image, or null if it has none.
 *
 * Both readers go through here — the publish path (which pipes them to the
 * user's PDS) and the proxy route `GET /api/recipe-image/$recipeId` (which
 * serves the draft's hero to the browser from our origin). Neither has a
 * second way to get an image, which is what keeps the invariant true on the
 * read side as well as the write side.
 */
export async function readPendingImage(db: Kysely<DB>, recipeId: string): Promise<PendingImageBytes | null> {
  const row = await db.selectFrom("recipe_pending_image").select(["object_key", "mime", "alt"]).where("recipe_id", "=", recipeId).executeTakeFirst();
  if (!row) return null;
  const { getBlob } = await import("#/lib/blob-storage");
  try {
    const bytes = await getBlob(row.object_key);
    return { bytes, mime: row.mime, alt: row.alt };
  } catch {
    // The row promised an object that is not there. Nothing to serve and
    // nothing to publish; the caller treats it as "no image".
    return null;
  }
}

/** Drop a recipe's pending image — pointer row first, then the bytes. */
export async function clearPendingImage(db: Kysely<DB>, recipeId: string): Promise<void> {
  const { deleteBlob } = await import("#/lib/blob-storage");
  await db.deleteFrom("recipe_pending_image").where("recipe_id", "=", recipeId).execute();
  await deleteBlob(pendingImageKey(recipeId)).catch(() => {});
}

// --- upload ids ----------------------------------------------------------

/** Mint the id a staged upload is addressed by. ULID: time-sortable, 26 chars. */
export async function mintUploadId(): Promise<string> {
  const { ulid } = await import("./household/ids");
  return ulid();
}
