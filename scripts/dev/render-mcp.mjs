#!/usr/bin/env node
/* global process, console */
// ^ The repo's eslint config targets the bundled app, where Node globals come
// from the type-checker. This file is plain JS run directly by Node, so
// `no-undef` needs them declared here (flat config dropped `/* eslint-env */`).
//
// Renders the gitignored `.mcp.json` from the committed `.mcp.json.example`.
//
// The two files differ in exactly one field: the postgres MCP server's
// `DATABASE_URI`. That URI points at the `railway dev` Postgres container on a
// host port Railway republishes whenever it recreates the container — so a
// hand-copied `.mcp.json` goes stale silently, and the postgres tools start
// failing to connect against a port nothing is listening on any more.
//
// The fix is to never write that port down: run this under
// `railway run --service buttery --`, which injects the current `DATABASE_URL`,
// and let it patch the example.
//
// Without `DATABASE_URL` in the environment this still writes the file, keeping
// whatever placeholder the example carries. That's the `mise install` case — a
// fresh clone that has never run `railway dev up` gets a valid `.mcp.json` with
// every other server wired up, and re-renders once the containers exist.
//
// Servers present in an existing `.mcp.json` but absent from the example are
// preserved: `.mcp.json` is gitignored and personal, so a locally-added server
// is not this script's to delete.
//
// Usage:
//   railway run --service buttery -- node scripts/dev/render-mcp.mjs
//   node scripts/dev/render-mcp.mjs        # no DATABASE_URL: placeholder kept

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const examplePath = join(root, ".mcp.json.example");
const targetPath = join(root, ".mcp.json");

function fail(message) {
  console.error(`render-mcp: ${message}`);
  process.exit(1);
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
  postgres.env = { ...postgres.env, DATABASE_URI: databaseUrl };
} else {
  console.error("render-mcp: no DATABASE_URL — keeping the example's placeholder. " + "Re-run `mise run mcp:setup` once the dev containers are up to fill it in.");
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
