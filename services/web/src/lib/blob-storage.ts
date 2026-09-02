import { createHash } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { MAX_IMAGE_BYTES } from "#/lib/recipe-image";

// Server-only module: Buttery-owned object storage (Railway bucket in prod,
// RustFS container in dev — both S3-compatible). This is the single door to
// anything Buttery holds on a user's behalf that is NOT yet an atproto blob —
// today that's recipe images before they are published.
//
// The invariant: **a recipe image Buttery has seen is Buttery's bytes.** The
// only images we render from someone else's host are atproto blobs on a CDN,
// which are the user's own bytes on their own PDS. We never persist, and never
// render, a third-party image URL.
//
// **Bytes never pass through this server.** The browser POSTs them straight to
// the bucket with a form we signed, and reads them back from a URL we signed.
// Buttery's part is authorization and key derivation: it decides who may write
// what, where, and for how long, and it never spends memory or egress on a
// megabyte it is only relaying. The one exception is publish, which reads the
// object back to pipe it to the user's PDS as a blob — a server-to-server hop
// the browser cannot make.
//
// Config comes from the environment (see .railway/railway.ts, which references
// the `buttery-uploads` bucket, and services/web/.env for local dev). Railway
// buckets are virtual-hosted style; the dev container is path-style only, hence
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
 * configure it — see docker-compose.yml's `rustfs` — but a bare `vite dev`
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
      // The dev bucket routes path-style only — a virtual-hosted request would
      // resolve `<bucket>.localhost` and never reach it. Railway's buckets are
      // virtual-hosted, so this stays off unless the environment asks for it.
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

// --- keys ----------------------------------------------------------------

/**
 * Where a recipe photo lands: `uploads/<account>/<ulid>`, and it never moves.
 *
 * The account is part of the key and the client is only ever handed the
 * `uploadId` half, so the server rebuilds the full key from the *session's* DID:
 * one account cannot claim another account's upload by guessing an id, and
 * nothing a client says reaches the key space. The `uploads/` prefix is also the
 * handle for a bucket lifecycle rule — an upload whose save never arrived is
 * garbage, and ULIDs sort by time, so expiring the prefix is the cleanup story
 * rather than a sweeper we have to write and schedule.
 *
 * The account is a HASH of the DID, not the DID, for two independent reasons and
 * either would be enough:
 *
 *   1. A DID contains colons (`did:plc:abc`), and a `:` in an object key is not
 *      portable. The AWS SDK and the S3 server disagree on whether SigV4's
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
export function uploadKey(did: string, uploadId: string): string {
  return `uploads/${createHash("sha256").update(did).digest("hex")}/${uploadId}`;
}

// --- presigned URLs ------------------------------------------------------

/** How long an upload URL stays good. Long enough for a slow phone, short enough to be forgotten. */
const UPLOAD_TTL_SECONDS = 15 * 60;

/**
 * How long a read URL stays good.
 *
 * A signed GET is a bearer token in a query string, so this is the window in
 * which a leaked recipe-list payload still resolves to bytes. An hour outlives
 * any page that holds one (the box query's cache included) and outlives no
 * session worth worrying about.
 */
const DOWNLOAD_TTL_SECONDS = 60 * 60;

/** A form the browser POSTs one file at, and the policy that bounds it. */
export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
}

/**
 * A presigned POST the browser may put exactly one image at, and nothing else.
 *
 * The three conditions are the whole security model of the upload path, and the
 * *bucket* enforces them — this server never sees a byte, so a check here would
 * be a check on a claim rather than on a body:
 *
 *   - `eq $key` — the object lands at the key we derived from the session's DID
 *     and nowhere else. A swapped key is `AccessDenied`.
 *   - `eq $Content-Type` — the declared type is the one we allowlisted. A
 *     swapped type is `AccessDenied`.
 *   - `content-length-range` — **the 2 MB cap.** A larger body is
 *     `EntityTooLarge` from the bucket, whatever the client claimed when it
 *     asked for this form.
 *
 * (Each of those was verified against the emulator the dev stack runs, not
 * inferred: an over-sized POST, a re-typed POST and a re-keyed POST were all
 * refused.)
 *
 * The mechanism is the one Railway documents for bucket uploads
 * (docs.railway.com/storage-buckets/uploading-serving). It needs a CORS policy
 * on the bucket allowing the app's origin, or the browser never sends the form.
 */
export async function presignUpload(key: string, contentType: string): Promise<PresignedUpload> {
  const { url, fields } = await createPresignedPost(getBlobClient(), {
    Bucket: getBucket(),
    Key: key,
    Expires: UPLOAD_TTL_SECONDS,
    Fields: { "Content-Type": contentType },
    Conditions: [
      ["eq", "$key", key],
      ["eq", "$Content-Type", contentType],
      ["content-length-range", 1, MAX_IMAGE_BYTES],
    ],
  });
  return { url, fields };
}

/**
 * A URL the browser may GET the object from, straight off the bucket.
 *
 * This replaced a proxy route on our own origin. The proxy meant every view of a
 * draft's hero was a megabyte through the web service's memory and egress, and
 * it bought authorization we already do at the only place that mints these: a
 * signed URL is only ever handed to a caller who has already passed the same
 * household check the proxy would have run.
 */
export async function presignDownload(key: string): Promise<string> {
  return await getSignedUrl(getBlobClient(), new GetObjectCommand({ Bucket: getBucket(), Key: key }), { expiresIn: DOWNLOAD_TTL_SECONDS });
}

// --- direct object access ------------------------------------------------

/**
 * The object's declared type and size, or null if it isn't there.
 *
 * This is how a save learns that the upload it was told about actually landed:
 * the browser reports success, but the bucket is the only thing that knows. It
 * also hands back the authoritative mime — the one the signature bound the
 * upload to — so the row records what the bucket holds rather than what the last
 * request claimed.
 */
export async function headBlob(key: string): Promise<{ size: number; mime: string } | null> {
  try {
    const res = await getBlobClient().send(new HeadObjectCommand({ Bucket: getBucket(), Key: key }));
    return { size: res.ContentLength ?? 0, mime: res.ContentType ?? "" };
  } catch {
    return null;
  }
}

/**
 * Read the full object at `key` back into memory.
 *
 * The one place bytes touch this server, and it exists for the one hop a browser
 * cannot make: publish, which uploads them to the author's PDS as a blob. Capped at
 * `MAX_IMAGE_BYTES` by the upload policy that let them in.
 */
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
