// Read-side blob → image URL construction. atproto blobs are addressable by
// (DID, blob CID): a CDN resolves the DID to its PDS and serves the matching
// blob, including our exchange.recipe.recipe images. Nothing is persisted —
// `recipe_image` stores blob_cid + blob_mime and the DID lives on `recipe`, so
// the URL is built fresh at render time.
//
// v1 uses Bluesky's CDN (works for any repo's blobs, offers resized presets).
// Swapping in a Buttery-owned proxy (Cloudflare Workers / porxie) later is a
// change to `IMAGE_CDN` only.

const IMAGE_CDN = "https://cdn.bsky.app";

/** cdn.bsky.app size presets. */
export type BlobImagePreset = "feed_fullsize" | "feed_thumbnail" | "avatar" | "avatar_thumbnail" | "banner";

// The CDN takes a format suffix; it transcodes, so png vs jpeg is the only
// distinction that matters.
function formatSuffix(mime: string | null | undefined): "png" | "jpeg" {
  return mime === "image/png" ? "png" : "jpeg";
}

/**
 * Build a browser-usable image URL for an atproto blob.
 *
 * @param did    the repo (uploading account) the blob lives in — `recipe.did`
 * @param cid    the blob CID — `recipe_image.blob_cid`
 * @param mime   the blob mime — `recipe_image.blob_mime` (picks @png vs @jpeg)
 * @param preset CDN size preset (default `feed_fullsize`)
 */
export function blobImageUrl(did: string, cid: string, mime?: string | null, preset: BlobImagePreset = "feed_fullsize"): string {
  // did/cid are untrusted (from network records). Percent-encode each path
  // segment so a stray '/', '@', '?', or '#' can't break out of its slot.
  // `preset` is a typed literal we control, so it goes in verbatim.
  return `${IMAGE_CDN}/img/${preset}/plain/${encodeURIComponent(did)}/${encodeURIComponent(cid)}@${formatSuffix(mime)}`;
}
