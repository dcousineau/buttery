import { copyRemoteImage, createRecipeImageUpload } from "#/lib/api";
import { MAX_IMAGE_BYTES, isAllowedImageMime } from "#/lib/recipe-image";

export type UploadedImage = { uploadId: string; previewUrl: string };

function isUploadable(blob: Blob): boolean {
  return blob.size > 0 && blob.size <= MAX_IMAGE_BYTES && isAllowedImageMime(blob.type);
}

/**
 * Upload a photo straight to Buttery's bucket through a presigned POST; the bytes
 * never touch the web service. Null on any failure, never a throw: a photo is the
 * one part of a recipe allowed to go missing.
 */
export async function uploadRecipeImage(blob: Blob, opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): Promise<UploadedImage | null> {
  if (!isUploadable(blob)) return null;
  try {
    const ticket = await createRecipeImageUpload({ mime: blob.type, size: blob.size });
    if (!ticket) return null;
    const form = new FormData();
    for (const [name, value] of Object.entries(ticket.fields)) form.append(name, value);
    // S3 takes the first `file` part as the body, so it goes after the policy fields.
    form.append("file", blob);
    const ok = await postWithProgress(ticket.url, form, opts);
    return ok ? { uploadId: ticket.uploadId, previewUrl: ticket.previewUrl } : null;
  } catch {
    return null;
  }
}

// XHR because `fetch` exposes no upload progress.
function postWithProgress(url: string, body: FormData, { signal, onProgress }: { signal?: AbortSignal; onProgress?: (fraction: number) => void }): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = xhr.onabort = () => resolve(false);
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

/**
 * Read a remote image from the browser so it can be uploaded as ours. The first of
 * two attempts: a plain CORS fetch, which a host that sends no
 * `Access-Control-Allow-Origin` refuses outright, so callers fall back to
 * `copyRemoteImageViaServer`. Null means "the browser could not get these bytes",
 * not "there is no photo".
 */
export async function fetchRemoteImage(url: string, signal?: AbortSignal): Promise<Blob | null> {
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit", signal });
    if (!res.ok) return null;
    const blob = await res.blob();
    // Hotlink-refusal pages often arrive as a 200 with an HTML body.
    return isUploadable(blob) ? blob : null;
  } catch {
    return null;
  }
}

/**
 * The second attempt: the server fetches the URL and puts the bytes in our bucket,
 * for hosts the browser cannot read at all. Null on any failure — including a throw,
 * which the server half is not supposed to produce — because a photo is the one part
 * of a recipe allowed to go missing.
 */
export async function copyRemoteImageViaServer(url: string): Promise<UploadedImage | null> {
  try {
    return await copyRemoteImage(url);
  } catch {
    return null;
  }
}
