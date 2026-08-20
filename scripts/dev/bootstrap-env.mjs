#!/usr/bin/env node
/* global process, console */
// ^ Plain JS run directly by Node (not part of the bundled app), so the Node
// globals have to be declared for the linter. Same reason as render-mcp.mjs.
//
// Creates each service's `.env` from its `.env.example` when it is missing,
// minting a throwaway `BETTER_AUTH_SECRET` for the one that asks for it.
//
// Three files today, one per service that reads config from disk:
//   * services/web/.env               — the app: datastores, auth, blobs, atproto
//   * services/atproto-cron-sync/.env — the sweep: its database + which atproto
//                                       network to read
//   * services/pipeline/.env          — the job queues: Redis, the board's port
//                                       and its basic-auth credentials
// They are deliberately separate rather than one root `.env`: each is loaded by
// its own service (vite.config.ts / kysely.config.ts, and the cron's and
// pipeline's src/config.ts), and the cron's file is what decides live-vs-local
// sweeping, which has no business being a repo-wide setting.
//
// Everything the stack needs to boot is already correct in the examples — the
// DATABASE_URL / REDIS_URL defaults match the fixed ports in the repo's
// docker-compose.yml — with exactly one blank: the better-auth signing secret,
// which has to be *some* value or the web server refuses to start. So a fresh
// clone's "copy the files, then run openssl" step is pure ceremony, and skipping
// it fails late and confusingly (migrations die on an undefined DATABASE_URL).
// `pnpm dev` and the `mise` postinstall hook run this first so the files exist
// before anything reads them, and so `mise run setup:mcp` bakes a real database
// URL into `.mcp.json` instead of the example's placeholder.
//
// Never overwrites an existing `.env`: once the file is there it is the
// developer's (real blob-storage credentials, a pinned secret, local edits).
// Each service is handled independently, so adding a new one to a checkout that
// already has the others only creates what is missing.
//
// Usage:
//   node scripts/dev/bootstrap-env.mjs
//   mise run setup:env                     # the same, wired into mise

import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Every service whose `.env.example` should be materialized. Add a service here
// when it grows a `.env.example`; nothing else in the script is service-aware.
const SERVICES = [join(root, "services", "web"), join(root, "services", "atproto-cron-sync"), join(root, "services", "pipeline")];

let failed = false;

for (const serviceDir of SERVICES) {
  const envPath = join(serviceDir, ".env");
  const examplePath = join(serviceDir, ".env.example");
  const label = relative(root, envPath);

  if (existsSync(envPath)) continue;

  if (!existsSync(examplePath)) {
    console.error(`bootstrap-env: ${relative(root, examplePath)} is missing — cannot create ${label}`);
    failed = true;
    continue;
  }

  const example = readFileSync(examplePath, "utf8");

  // The web example carries `BETTER_AUTH_SECRET=` with an empty value; fill it
  // with the same thing `openssl rand -base64 32` would produce. Local-only and
  // disposable — rotating it just signs everyone out of the dev server. An
  // example without that line (the cron's) is copied through untouched.
  const secret = randomBytes(32).toString("base64");
  const filled = example.replace(/^BETTER_AUTH_SECRET=\s*$/m, `BETTER_AUTH_SECRET=${secret}`);

  if (filled === example && /^BETTER_AUTH_SECRET=/m.test(example)) {
    // The line exists but already has a value, or the example changed shape.
    // Copy verbatim rather than silently writing a .env the server will reject,
    // and say what is left to do.
    copyFileSync(examplePath, envPath);
    console.error(`bootstrap-env: wrote ${label} but left BETTER_AUTH_SECRET as-is — set one by hand (openssl rand -base64 32).`);
    continue;
  }

  writeFileSync(envPath, filled);
  console.log(filled === example ? `bootstrap-env: created ${label} from .env.example.` : `bootstrap-env: created ${label} from .env.example with a generated BETTER_AUTH_SECRET.`);
}

if (failed) process.exit(1);
