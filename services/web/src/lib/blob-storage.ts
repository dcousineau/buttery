import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

// Server-only module: Buttery-owned object storage (Railway bucket, S3-compatible
// API). This is the single upload/download util for anything Buttery holds on a
// user's behalf that is NOT yet an atproto blob — today that's pending recipe
// draft images. On publish the object is read back, uploaded to the user's PDS as
// an atproto blob, then deleted here.
//
// Config comes from the environment (see .railway/railway.ts, which references the
// `buttery-uploads` bucket, and services/web/.env for local dev). Railway buckets
// are virtual-hosted style, so we only need the base endpoint + credentials.
//
// General rule: all Buttery-side file uploads use this bucket, never Postgres bytea.

let client: S3Client | undefined;
let bucketName: string | undefined;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** Lazily-created S3 client bound to the Railway bucket. */
export function getBlobClient(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: env("BLOB_S3_ENDPOINT"),
      region: env("BLOB_S3_REGION"),
      credentials: {
        accessKeyId: env("BLOB_S3_ACCESS_KEY_ID"),
        secretAccessKey: env("BLOB_S3_SECRET_ACCESS_KEY"),
      },
    });
  }
  return client;
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
