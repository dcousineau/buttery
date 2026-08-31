import { createFileRoute } from "@tanstack/react-router";

/**
 * `POST /api/recipe-image/staged` — the browser hands Buttery image bytes.
 *
 * This is the primary way a recipe photo reaches us, and it exists because the
 * server is the *worse* of the two fetchers. Hotlink protection keys on Referer
 * and datacenter IP ranges are easy to block, so a recipe host that serves an
 * image happily to the tab that is looking at the page will refuse the same
 * request from our backend. The tab also already holds the bytes outright for a
 * folder import (the photos came out of the dropped export) and a file picker,
 * where there is no fetch to be refused at all. `storePendingImageFromUrl` on
 * the server stays as the fallback for the reverse case: a host with no CORS
 * headers, which the browser cannot read but we can.
 *
 * A route rather than a server function because the payload is bytes: a server
 * function would mean base64 in a JSON envelope, a third larger, for the one
 * request in the app that is nothing but a binary body.
 *
 * The response is an opaque `uploadId`, not an object key. The caller sends it
 * back on `saveRecipe` / the import commit and the server rebuilds the key as
 * `staged/<session did>/<uploadId>` — so an id is only ever redeemable by the
 * account that uploaded it, and nothing a client says reaches the key space.
 *
 * Nothing here writes to the database. An upload that is never claimed is an
 * orphan under `staged/`, which is what the prefix is for: ULIDs sort by time,
 * so expiring the prefix is a bucket lifecycle rule rather than a sweeper we
 * have to write and schedule.
 */

function problem(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
  });
}

async function handler({ request }: { request: Request }): Promise<Response> {
  const { getServerSession } = await import("#/server/household/session");
  const { isBlobStorageConfigured, putBlob } = await import("#/lib/blob-storage");
  const { MAX_IMAGE_BYTES, mintUploadId, stagedImageKey, validateImageBytes } = await import("#/server/recipe-images");

  const session = await getServerSession(request);
  const did = session?.user.did ?? null;
  if (!did) return problem(401, "Sign in to upload a recipe photo.");

  if (!isBlobStorageConfigured()) {
    // Local dev without the `local-s3` container, essentially. Say which knob
    // is missing rather than surfacing an S3 client stack trace.
    return problem(503, "Object storage is not configured (BLOB_S3_*).");
  }

  // Cheap rejection before reading a body at all. `content-length` is a hint a
  // client controls, so the real cap is the byte length check below; this only
  // saves us reading a megabyte we already know we will refuse.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    return problem(413, "Recipe photos must be 1 MB or smaller.");
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return problem(400, "Could not read the upload.");
  }

  // Sniffed, never believed: the `content-type` header is the client's claim,
  // and this object is later served back from our own origin and uploaded to a
  // PDS as a typed blob. `validateImageBytes` decides from magic bytes and
  // enforces the lexicon's 1 MB cap.
  const image = validateImageBytes(bytes);
  if (!image) {
    return problem(415, "That doesn't look like an image we can store (JPEG, PNG, GIF, WebP, AVIF or HEIC, 1 MB or smaller).");
  }

  const uploadId = await mintUploadId();
  await putBlob(stagedImageKey(did, uploadId), image.bytes, image.mime);

  return new Response(JSON.stringify({ uploadId, mime: image.mime }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
  });
}

export const Route = createFileRoute("/api/recipe-image/staged")({
  server: {
    handlers: {
      POST: handler,
    },
  },
});
