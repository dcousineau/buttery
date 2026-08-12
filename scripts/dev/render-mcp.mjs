#!/usr/bin/env node
/* global process, console */
// ^ The repo's eslint config targets the bundled app, where Node globals come
// from the type-checker. This file is plain JS run directly by Node, so
// `no-undef` needs them declared here (flat config dropped `/* eslint-env */`).
//
// Renders the gitignored `.mcp.json` from the committed `.mcp.json.example`.
//
// The two files differ in exactly one field: the postgres MCP server's
// `DATABASE_URI`. Local dev's Postgres lives in the repo's docker-compose stack
// (docker-compose.yml) on a fixed host port, and its connection string is the
// `DATABASE_URL` in `services/web/.env` — the same file the web server and the
// migration CLI read. MCP clients don't read `.env`, so the URL has to be baked
// into `.mcp.json`; this script does that so the two never drift.
//
// Two rewrites happen on the way in:
//
//   * The value is read from `services/web/.env` (or, failing that, an ambient
//     `DATABASE_URL` in the environment). No Railway CLI is involved — local
//     dev dropped `railway run` when it moved to docker-compose.
//   * The host is rewritten `localhost`/`127.0.0.1` -> `host.docker.internal`.
//     The postgres MCP server runs *inside* a docker container
//     (`crystaldba/postgres-mcp`, launched with
//     `--add-host=host.docker.internal:host-gateway`), so `localhost` there is
//     the container, not the host. `host.docker.internal` is how the container
//     reaches the Postgres published on the host by docker-compose.
//
// Without a DATABASE_URL from either source this still writes the file, keeping
// whatever placeholder the example carries. That's the `mise install` case — a
// fresh clone that has never copied `.env` gets a valid `.mcp.json` with every
// other server wired up, and re-renders once `.env` exists.
//
// Servers present in an existing `.mcp.json` but absent from the example are
// preserved: `.mcp.json` is gitignored and personal, so a locally-added server
// is not this script's to delete.
//
// Usage:
//   node scripts/dev/render-mcp.mjs        # reads services/web/.env
//   mise run mcp:setup                     # the same, wired into mise

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const examplePath = join(root, ".mcp.json.example");
const targetPath = join(root, ".mcp.json");
const envPath = join(root, "services", "web", ".env");

function fail(message) {
  console.error(`render-mcp: ${message}`);
  process.exit(1);
}

// Load services/web/.env into process.env the same way kysely.config.ts and
// vite.config.ts do, so DATABASE_URL comes from the one source of truth. A
// pre-existing ambient DATABASE_URL still wins (loadEnvFile does not overwrite
// already-set vars), which keeps CI / one-off overrides working.
try {
  process.loadEnvFile(envPath);
} catch {
  // No services/web/.env yet — fall back to the ambient environment (which may
  // also be empty; handled below by keeping the example's placeholder).
}

// The postgres MCP runs in a container; rewrite a host-loopback authority to the
// docker gateway alias so it can reach the Postgres published on the host.
function forDockerContainer(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      parsed.hostname = "host.docker.internal";
    }
    return parsed.toString();
  } catch {
    // Not a parseable URL (e.g. the example placeholder). Leave it untouched;
    // the DATABASE_URL branch below only runs for real values anyway.
    return url;
  }
}

let config;
try {
  config = JSON.parse(readFileSync(examplePath, "utf8"));
} catch (error) {
  fail(`could not read ${examplePath}: ${error.message}`);
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  const postgres = config.mcpServers?.postgres;
  if (!postgres) fail(".mcp.json.example has no `postgres` server to point at the dev database");
  postgres.env = { ...postgres.env, DATABASE_URI: forDockerContainer(databaseUrl) };
} else {
  console.error("render-mcp: no DATABASE_URL (checked services/web/.env and the environment) — " + "keeping the example's placeholder. Copy services/web/.env.example to .env and re-run `mise run mcp:setup`.");
}

// Merge, don't clobber: keep any server this checkout added on its own.
if (existsSync(targetPath)) {
  let existing;
  try {
    existing = JSON.parse(readFileSync(targetPath, "utf8"));
  } catch (error) {
    fail(`${targetPath} exists but is not valid JSON (${error.message}) — delete it and re-run`);
  }
  for (const [name, server] of Object.entries(existing.mcpServers ?? {})) {
    if (!(name in config.mcpServers)) config.mcpServers[name] = server;
  }
}

const rendered = `${JSON.stringify(config, null, 2)}\n`;
if (existsSync(targetPath) && readFileSync(targetPath, "utf8") === rendered) process.exit(0);

writeFileSync(targetPath, rendered);
// Claude Code reads `.mcp.json` once at session start, so a rewrite mid-session
// only takes effect on the next one. Say so rather than changing it silently.
console.log("render-mcp: wrote .mcp.json — restart your MCP client to pick it up.");
