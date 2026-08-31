import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

// Server-only module: Buttery-owned object storage (Railway bucket in prod,
// `local-s3` container in dev — both S3-compatible). This is the single
// upload/download util for anything Buttery holds on a user's behalf that is
// NOT yet an atproto blob — today that's recipe images, staged and pending.
//
// The invariant this module exists to serve: **a recipe image Buttery has seen
// is Buttery's bytes.** Every image that arrives through us (manual create,
// single-URL import, folder import) is uploaded here first; the only images we
// render from someone else's host are atproto blobs on a CDN, which are the
// user's own bytes on their own PDS. We never persist, and never render, a
// third-party image URL. See src/server/recipe-images.ts, which owns that rule.
//
// Config comes from the environment (see .railway/railway.ts, which references
// the `buttery-uploads` bucket, and services/web/.env for local dev). Railway
// buckets are virtual-hosted style; `local-s3` is path-style only, hence
// BLOB_S3_FORCE_PATH_STYLE.
//
// General rule: all Buttery-side file uploads use this bucket, never Postgres bytea.

let client: S3Client | undefined;
let bucketName: string | undefined;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/**
 * Whether the bucket is configured at all.
 *
 * Local dev can run the whole app without object storage (the dev stack does
 * configure it — see docker-compose.yml's `local-s3` — but a bare `vite dev`
 * against a remote database may not). Callers on the image path use this to
 * fail with a sentence a developer can act on instead of an S3 stack trace.
 */
export function isBlobStorageConfigured(): boolean {
  return Boolean(process.env.BLOB_S3_ENDPOINT && process.env.BLOB_S3_BUCKET && process.env.BLOB_S3_ACCESS_KEY_ID && process.env.BLOB_S3_SECRET_ACCESS_KEY);
}

/** Lazily-created S3 client bound to the configured bucket. */
export function getBlobClient(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: env("BLOB_S3_ENDPOINT"),
      region: process.env.BLOB_S3_REGION || "us-east-1",
      credentials: {
        accessKeyId: env("BLOB_S3_ACCESS_KEY_ID"),
        secretAccessKey: env("BLOB_S3_SECRET_ACCESS_KEY"),
      },
      // `local-s3` (ghcr.io/shyim/local-s3) routes path-style only — a
      // virtual-hosted request would resolve `<bucket>.localhost` and never
      // reach it. Railway's buckets are virtual-hosted, so this stays off
      // unless the environment asks for it.
      forcePathStyle: isTruthy(process.env.BLOB_S3_FORCE_PATH_STYLE),
    });
  }
  return client;
}

function isTruthy(v: string | undefined): boolean {
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function getBucket(): string {
  if (!bucketName) bucketName = env("BLOB_S3_BUCKET");
  return bucketName;
}

/** Store bytes under `key`. Overwrites any existing object at that key. */
export async function putBlob(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await getBlobClient().send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/** Read the full object at `key` back into memory. */
export async function getBlob(key: string): Promise<Uint8Array> {
  const res = await getBlobClient().send(new GetObjectCommand({ Bucket: getBucket(), Key: key }));
  if (!res.Body) throw new Error(`blob ${key} has no body`);
  // AWS SDK v3 Node stream → bytes.
  return await res.Body.transformToByteArray();
}

/** Delete the object at `key`. Idempotent — deleting a missing key is a no-op. */
export async function deleteBlob(key: string): Promise<void> {
  await getBlobClient().send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }));
}

// Deliberately no `moveBlob`/CopyObject helper: `local-s3` implements
// Put/Get/Head/Delete and nothing else, so a CopyObject-based move would work
// in production and 501 on every developer's laptop — the exact failure a local
// S3 exists to catch. `src/server/recipe-images.ts` moves the one object it
// needs to (staged → pending) as get + put + delete; recipe images are capped
// at 1 MB, so the round trip through memory costs nothing worth optimizing.
