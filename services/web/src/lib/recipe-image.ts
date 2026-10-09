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
 * The image type these bytes actually are, or null if they are not a type we accept.
 *
 * Every other check on this path reasons about a *declared* type, because on
 * every other path the bytes never touch this server and the declaration comes
 * from the user's own browser. `copyRemoteImage` is the exception: those bytes
 * do pass through the server, and the party declaring their content type is a
 * third-party host we asked for a favour. Its declaration is therefore not
 * evidence. A host with hotlink protection answers `200 image/jpeg` with an HTML
 * refusal page in the body, and storing that would put a document where a photo
 * belongs and later hand a PDS a blob it cannot decode. The magic bytes are the
 * only statement about the content that the content itself makes, so they are
 * what decides the stored type.
 *
 * Signatures only, no decode: the question is "is this the image family it
 * claims", not "is this image intact". A truncated JPEG still passes here and
 * fails at render, where failing costs nothing.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  // The longest signature below reads through offset 11; no real image is smaller.
  if (bytes.length < 12) return null;

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a)
    return "image/png";

  const head6 = tag(bytes, 0, 6);
  if (head6 === "GIF87a" || head6 === "GIF89a") return "image/gif";

  // WebP is a RIFF container; the form type at offset 8 is what distinguishes it
  // from every other RIFF payload (audio included).
  if (tag(bytes, 0, 4) === "RIFF" && tag(bytes, 8, 4) === "WEBP") return "image/webp";

  // AVIF and HEIC are both ISO-BMFF, so the `ftyp` box alone says nothing — the
  // brand that follows it is the only thing separating them, and separating
  // either from an MP4.
  if (tag(bytes, 4, 4) === "ftyp") {
    const brand = tag(bytes, 8, 4);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "heic" || brand === "heix" || brand === "heim" || brand === "heis" || brand === "hevc" || brand === "hevx" || brand === "mif1") return "image/heic";
  }

  return null;
}

/** The bytes at `[offset, offset + length)` read as a latin-1 string, for comparing four-character container tags. */
function tag(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
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
