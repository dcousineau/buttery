#!/usr/bin/env node
/* global process, console */
// ^ Plain JS run directly by Node (not part of the bundled app), so the Node
// globals have to be declared for the linter. Same reason as render-mcp.mjs.
//
// Creates `services/web/.env` from `services/web/.env.example` when it is
// missing, minting a throwaway `BETTER_AUTH_SECRET` on the way.
//
// Everything the stack needs to boot is already correct in the example — the
// DATABASE_URL / REDIS_URL defaults match the fixed ports in the repo's
// docker-compose.yml — with exactly one blank: the better-auth signing secret,
// which has to be *some* value or the web server refuses to start. So a fresh
// clone's "copy the file, then run openssl" step is pure ceremony, and skipping
// it fails late and confusingly (migrations die on an undefined DATABASE_URL).
// `pnpm dev` and the `mise` postinstall hook run this first so the file exists
// before anything reads it, and so `mise run setup:mcp` bakes a real database
// URL into `.mcp.json` instead of the example's placeholder.
//
// Never overwrites an existing `.env`: once the file is there it is the
// developer's (real blob-storage credentials, a pinned secret, local edits).
//
// Usage:
//   node scripts/dev/bootstrap-env.mjs
//   mise run setup:env                     # the same, wired into mise

import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const envPath = join(root, "services", "web", ".env");
const examplePath = join(root, "services", "web", ".env.example");

if (existsSync(envPath)) process.exit(0);

if (!existsSync(examplePath)) {
  console.error(`bootstrap-env: ${examplePath} is missing — cannot create services/web/.env`);
  process.exit(1);
}

const example = readFileSync(examplePath, "utf8");

// The example carries `BETTER_AUTH_SECRET=` with an empty value; fill it with
// the same thing `openssl rand -base64 32` would produce. Local-only and
// disposable — rotating it just signs everyone out of the dev server.
const secret = randomBytes(32).toString("base64");
const filled = example.replace(/^BETTER_AUTH_SECRET=.*$/m, `BETTER_AUTH_SECRET=${secret}`);

if (filled === example) {
  // No line to fill (the example changed shape). Copy verbatim rather than
  // silently writing a .env the server will reject, and say what is left to do.
  copyFileSync(examplePath, envPath);
  console.error("bootstrap-env: wrote services/web/.env but found no BETTER_AUTH_SECRET line to fill — set one by hand (openssl rand -base64 32).");
  process.exit(0);
}

writeFileSync(envPath, filled);
console.log("bootstrap-env: created services/web/.env from .env.example with a generated BETTER_AUTH_SECRET.");
