#!/usr/bin/env node
/* global process, console */
// ^ Plain JS run directly by Node (not part of the bundled app), so the Node
// globals have to be declared for the linter. Same reason as bootstrap-env.mjs.
//
// Creates the local S3 bucket the web service uploads recipe images to.
//
// `local-s3` (the repo's docker-compose.yml) persists objects on a volume but
// does not pre-create buckets from configuration — `CreateBucket` is an API
// call, and something has to make it. This is that something, run once per boot
// by the `local-s3-bucket` process in process-compose.yaml, after the container
// is healthy and before the web server can be asked for an image.
//
// It lives under services/web rather than scripts/dev because it imports the
// app's own S3 client: `@aws-sdk/client-s3` is this package's dependency, and
// ESM resolves from the importing file's directory, not the cwd.
//
// Idempotent: an existing bucket answers `BucketAlreadyOwnedByYou` (or
// `BucketAlreadyExists`) and that is a success here, so it is safe on every
// boot and after `docker compose down -v`.
//
// It reads the same BLOB_S3_* variables the app does, from services/web/.env,
// so there is one definition of where the bucket is and what signs for it. If
// those are unset the stack is running without object storage on purpose (see
// the .env.example header) and this exits 0 with a note rather than failing the
// boot.
//
// Usage:
//   pnpm --filter @buttery/web dev:bucket

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");

/**
 * Minimal `KEY=value` reader. Deliberately not dotenv: this script runs before
 * anything installs into the root workspace's node_modules in a fresh clone,
 * and the file it reads is the repo's own generated one, not user input.
 */
function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const fileEnv = readEnvFile(envPath);
// A real process env wins over the file, matching how the app is configured in
// deployed environments.
const cfg = (name) => process.env[name] || fileEnv[name] || "";

const endpoint = cfg("BLOB_S3_ENDPOINT");
const bucket = cfg("BLOB_S3_BUCKET");
const accessKeyId = cfg("BLOB_S3_ACCESS_KEY_ID");
const secretAccessKey = cfg("BLOB_S3_SECRET_ACCESS_KEY");

if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
  console.log("create-bucket: BLOB_S3_* not configured in services/web/.env — skipping (the image path is off).");
  process.exit(0);
}

// Placeholder values from `.env.example` that a developer never filled in. Same
// reasoning as above: not configured is not an error.
if (endpoint.startsWith("<")) {
  // A checkout whose `.env` predates the local-s3 container: bootstrap-env.mjs
  // never overwrites an existing file, so the old remote-bucket placeholders
  // are still in there. Say exactly what to do — the alternative is a web
  // server that boots fine and then 500s on the first recipe photo.
  console.log("create-bucket: services/web/.env still has the old remote-bucket placeholders for BLOB_S3_*.");
  console.log("create-bucket: copy the BLOB_S3_* block from services/web/.env.example over them to use the local-s3 container. Skipping for now.");
  process.exit(0);
}

// Imported after the config check so a stack running without object storage
// does not pay for loading the SDK.
const { CreateBucketCommand, HeadBucketCommand, S3Client } = await import("@aws-sdk/client-s3");

const client = new S3Client({
  endpoint,
  region: cfg("BLOB_S3_REGION") || "us-east-1",
  credentials: { accessKeyId, secretAccessKey },
  // local-s3 is path-style only; see docker-compose.yml.
  forcePathStyle: (cfg("BLOB_S3_FORCE_PATH_STYLE") || "").toLowerCase() === "true",
});

try {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  console.log(`create-bucket: ${bucket} already exists at ${endpoint}`);
  process.exit(0);
} catch {
  // Absent (or the server does not answer HEAD on a bucket) — fall through to
  // the create, which is the call that actually decides.
}

try {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`create-bucket: created ${bucket} at ${endpoint}`);
} catch (err) {
  const name = err?.name ?? "";
  if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") {
    console.log(`create-bucket: ${bucket} already exists at ${endpoint}`);
    process.exit(0);
  }
  console.error(`create-bucket: could not create ${bucket} at ${endpoint}: ${err?.message ?? err}`);
  process.exit(1);
}
