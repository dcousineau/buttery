/**
 * The browser half of "Buttery stores its own image bytes".
 *
 * The server is the worse of the two fetchers, which is why this exists. A
 * recipe host that serves a photo happily to the tab looking at its page will
 * refuse the identical request from our backend — hotlink protection keys on
 * `Referer` and datacenter IP ranges are trivially blocked. And for a folder
 * import there is no fetch to refuse: the tab already holds the photo as a
 * `File` out of the dropped export, bytes the server has never had any way to
 * reach at all.
 *
 * So the browser goes first, and the server's SSRF-guarded fetch is the
 * fallback for the reverse case — a host with no CORS headers, which the tab
 * cannot read but we can. Between them the corpus is covered; neither alone is.
 *
 * Everything here returns null rather than throwing. A photo is the one part of
 * a recipe that is allowed to go missing: losing an import because a CDN was
 * rude would be the wrong trade, and the caller always has the fallback left.
 */

/** Lexicon blob cap for `exchange.recipe.recipe` images. Mirrored server-side. */
export const MAX_IMAGE_BYTES = 1_000_000;

/** The endpoint's success shape. `mime` is what the server sniffed, not what we claimed. */
export interface StagedUpload {
  uploadId: string;
  mime: string;
}

/**
 * PUT bytes to `/api/recipe-image/staged` and get back the id the commit
 * references.
 *
 * The id is opaque and is only redeemable by the account that uploaded it: the
 * server rebuilds the object key from the *session's* DID, so nothing the
 * client sends reaches the bucket's key space.
 */
export async function uploadStagedImage(blob: Blob, signal?: AbortSignal): Promise<StagedUpload | null> {
  if (blob.size === 0 || blob.size > MAX_IMAGE_BYTES) return null;
  try {
    const res = await fetch("/api/recipe-image/staged", {
      method: "POST",
      body: blob,
      // A hint only — the server sniffs magic bytes and stores what it found.
      headers: { "content-type": blob.type || "application/octet-stream" },
      signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<StagedUpload>;
    return body.uploadId ? { uploadId: body.uploadId, mime: body.mime ?? blob.type } : null;
  } catch {
    return null;
  }
}

/**
 * Try to read a remote image from the browser.
 *
 * This is a plain CORS fetch, and it fails on any host that does not send
 * `Access-Control-Allow-Origin` — which is many of them. That is expected and
 * is the whole reason the server keeps its own fetch: the two fail on disjoint
 * sets of hosts. `no-cors` is not an option here and never will be — an opaque
 * response has no readable body, so there would be no bytes to upload.
 *
 * Nothing about the URL is retained on success or failure. It is a place we
 * read from once.
 */
export async function fetchRemoteImage(url: string, signal?: AbortSignal): Promise<Blob | null> {
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit", signal });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size === 0 || blob.size > MAX_IMAGE_BYTES) return null;
    // A hotlink-refusal page served with a 200 is common enough to check for.
    if (blob.type && !blob.type.startsWith("image/")) return null;
    return blob;
  } catch {
    return null;
  }
}

/**
 * Best effort, browser-side: remote URL → staged upload id.
 *
 * Returns null when the tab could not get the bytes, which is the caller's
 * signal to fall back to handing the server the URL instead. It is never the
 * signal to give up on the recipe.
 */
export async function stageRemoteImage(url: string, signal?: AbortSignal): Promise<StagedUpload | null> {
  const blob = await fetchRemoteImage(url, signal);
  if (!blob) return null;
  return await uploadStagedImage(blob, signal);
}

/**
 * Blob → `data:` URL, for the one caller that sends its image inline rather
 * than staging it: the create form, which has a single image and no reason to
 * spend a second round trip on it. The server decodes past the `data:` prefix.
 */
export function readAsDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}
