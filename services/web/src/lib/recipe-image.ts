/**
 * What Buttery will accept as a recipe photo. Client-safe, and the only copy.
 *
 * These four facts are needed on both sides of an upload — the browser checks
 * before asking for a URL, the server checks before signing one — so they live
 * in a module with no imports rather than as a constant and its drifting mirror.
 */

/**
 * The hard cap on a recipe photo.
 *
 * 2 MB is Bluesky's current blob limit. A published recipe's image becomes a
 * blob on the author's PDS, so the binding constraint is the network's, not
 * ours: an image we would happily store and then fail to publish is worse than
 * one we refuse at the file picker.
 *
 * Enforced by the upload's own SigV4 signature, not by a check anything can
 * skip — `presignUpload` signs the exact byte count, so a larger body is a 403
 * from the bucket. This constant is what the two ends agree the number is.
 */
export const MAX_IMAGE_BYTES = 2_000_000;

/**
 * The image types an upload may declare.
 *
 * An allowlist rather than `image/*` because the declared type is signed into
 * the upload URL, is what the bucket stores, is what a signed GET serves back,
 * and is what the PDS blob is encoded as. `image/svg+xml` is deliberately
 * absent: an SVG is a document that can script, and these bytes are
 * user-supplied.
 */
export const ALLOWED_IMAGE_MIME = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/heic"] as const;

export function isAllowedImageMime(mime: string): boolean {
  return (ALLOWED_IMAGE_MIME as readonly string[]).includes(mime);
}

/**
 * Upload ids are minted server-side and travel through a browser, so they are
 * validated on the way back in rather than trusted: they land in an object key,
 * and a key with a `/` or a `..` in it is a path traversal in the bucket's
 * namespace. ULID: time-sortable, 26 chars of Crockford base32.
 */
export function isValidUploadId(uploadId: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(uploadId);
}
