import { createRecipeImageUpload } from "#/lib/api";
import { MAX_IMAGE_BYTES, isAllowedImageMime } from "#/lib/recipe-image";

/**
 * The browser puts a recipe photo in Buttery's bucket. Directly — we are not in
 * the middle of it.
 *
 * Two steps, one round trip each: ask the server for a presigned POST, then send
 * the file at it as a form. The bytes never touch the web service, so an import
 * of 341 recipes costs it 341 signatures instead of 341 megabytes of memory and
 * egress. This replaced a `POST /api/recipe-image/staged` route that read the
 * whole body into the server and re-uploaded it.
 *
 * The checks below only save a round trip. What actually bounds the upload is
 * the policy inside `fields` — key, content type and a 2 MB `content-length-range`
 * — which the bucket enforces on the body itself, where we could not.
 *
 * The `uploadId` that comes back is opaque and only redeemable by the account
 * that asked for it: the server derived the object key from the *session's* DID,
 * so nothing a client sends reaches the bucket's key space.
 *
 * Returns null rather than throwing, always. A photo is the one part of a recipe
 * that is allowed to go missing — losing an import because a bucket was slow
 * would be the wrong trade — so every caller reads null as "this recipe has no
 * image", never as an error.
 */
export async function uploadRecipeImage(blob: Blob, signal?: AbortSignal): Promise<string | null> {
  // A blob with no `type` is not guessed at: an upload declares a mime the
  // policy will be written against, or it does not happen.
  if (blob.size === 0 || blob.size > MAX_IMAGE_BYTES) return null;
  if (!isAllowedImageMime(blob.type)) return null;
  try {
    const ticket = await createRecipeImageUpload({ mime: blob.type, size: blob.size });
    if (!ticket) return null;
    const form = new FormData();
    for (const [name, value] of Object.entries(ticket.fields)) form.append(name, value);
    // S3 reads the policy fields in order and takes the first `file` part as the
    // body, so the file goes last.
    form.append("file", blob);
    const res = await fetch(ticket.url, { method: "POST", body: form, signal });
    return res.ok ? ticket.uploadId : null;
  } catch {
    return null;
  }
}

/**
 * Try to read a remote image from the browser, so it can be uploaded as ours.
 *
 * This is a plain CORS fetch, and it fails on any host that does not send
 * `Access-Control-Allow-Origin` — which is many of them. There is no server-side
 * fetch behind it any more: that fallback was refused more often than this is
 * (hotlink protection keys on Referer, and a datacenter IP is an easy block) and
 * it was the only thing that ever made a third-party URL storable. A hero we
 * cannot read is a recipe with no photo.
 *
 * `no-cors` is not an option here and never will be — an opaque response has no
 * readable body, so there would be nothing to upload.
 *
 * Nothing about the URL is retained on success or failure. It is a place we read
 * from once.
 */
export async function fetchRemoteImage(url: string, signal?: AbortSignal): Promise<Blob | null> {
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit", signal });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size === 0 || blob.size > MAX_IMAGE_BYTES) return null;
    // A hotlink-refusal page served with a 200 is common enough to check for,
    // and the type has to be one we can declare on the upload anyway.
    if (!isAllowedImageMime(blob.type)) return null;
    return blob;
  } catch {
    return null;
  }
}

/** Best effort, browser-side: remote URL → bytes in our bucket → upload id. */
export async function stageRemoteImage(url: string, signal?: AbortSignal): Promise<string | null> {
  const blob = await fetchRemoteImage(url, signal);
  return blob ? await uploadRecipeImage(blob, signal) : null;
}
