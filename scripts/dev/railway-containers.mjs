#!/usr/bin/env node
/* global process, console, setTimeout */
// ^ The repo's eslint config targets the bundled app, where Node globals come
// from the type-checker. This file is plain JS run directly by Node, so
// `no-undef` needs them declared here (flat config dropped `/* eslint-env */`).
//
// Bridge between `railway dev`'s docker containers and process-compose.
//
// `railway dev up` starts Postgres/Redis/Caddy as detached docker-compose
// containers and exits. That gives process-compose nothing to supervise, so we
// surface each container as its own process-compose service: one log tail per
// container, plus readiness probes the app processes can wait on.
//
// Everything here goes through `docker compose -f <generated file>` rather than
// `docker <cmd> <container-name>`, for one specific reason: `docker logs -f`
// dies the moment its container restarts — AND exits 0, so process-compose
// records the tail as `Completed` rather than failed and leaves it dead. The
// containers ship with `restart: on-failure`, so that happens on any crash, and
// a dead `postgres`/`redis` tail takes its readiness probe with it — which is
// what `web` gates on, so the web server can then never come back. `docker
// compose logs -f` follows the *service* and reattaches across both restarts
// and full recreates.
//
// The compose file `railway dev up` generates is the source of truth for ports,
// credentials, and container naming. It lives in machine-local state keyed by
// checkout path (`~/.railway/config.json` → project id →
// `~/.railway/develop/<project-id>/docker-compose.yml`), holds live production
// credentials, and is NOT stable across clones — so it is resolved at runtime
// here and must never be copied into the repo. It also cannot be relocated:
// `railway-proxy` mounts `./Caddyfile` and `./certs` relative to it, and
// `railway dev up -o <elsewhere>` writes the yaml without those siblings.
//
// Usage:
//   node scripts/dev/railway-containers.mjs logs  <service>   # stream, stays attached
//   node scripts/dev/railway-containers.mjs ready <service>   # exit 0 when serving
//   node scripts/dev/railway-containers.mjs compose-file      # print the resolved path

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** How long `logs` waits for its container to appear before giving up. */
const CONTAINER_WAIT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

function fail(message) {
  console.error(`railway-containers: ${message}`);
  process.exit(1);
}

/**
 * Railway project id == docker-compose project name for `railway dev`.
 * Looked up by checkout path, with a scan fallback in case the CLI ever
 * normalizes the key differently than `process.cwd()` renders it.
 */
function projectId() {
  const configPath = join(homedir(), ".railway", "config.json");
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    fail(`could not read ${configPath} (is the Railway CLI linked? run \`railway link\`): ${error.message}`);
  }
  const projects = config.projects ?? {};
  const cwd = process.cwd();
  const entry = projects[cwd] ?? Object.values(projects).find((p) => p?.projectPath === cwd);
  if (!entry?.project) fail(`no linked Railway project for ${cwd} — run \`railway link\``);
  return entry.project;
}

/** Path `railway dev up` writes its generated compose file to. */
function composePath() {
  return join(homedir(), ".railway", "develop", projectId(), "docker-compose.yml");
}

/**
 * Resolved compose file, or bail. Absence means `railway dev up` has not run in
 * this checkout yet — the file is generated, never committed.
 */
function composeFile() {
  const path = composePath();
  if (!existsSync(path)) fail(`no compose file at ${path} — run \`railway dev up\` first`);
  return path;
}

function compose(file, argv, options = {}) {
  return spawnSync("docker", ["compose", "-f", file, ...argv], { encoding: "utf8", ...options });
}

function isRunning(file, service) {
  // `ps -q` prints the container id only while it matches the status filter, so
  // empty stdout covers "not created yet", "stopped", and "mid-restart" alike.
  const result = compose(file, ["ps", "--status", "running", "-q", service]);
  return result.status === 0 && result.stdout.trim() !== "";
}

function execInService(file, service, argv) {
  // -T: no TTY. Without it `docker compose exec` fails outright when the probe
  // runs with a non-tty stdin, which is exactly how process-compose runs it.
  return compose(file, ["exec", "-T", service, ...argv]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Readiness per container. Postgres and Redis get real protocol-level checks so
 * dependents (migrations, the web server) don't race a still-booting server;
 * anything else is considered ready once the container is up.
 */
const READY_CHECKS = {
  postgres: (file) => execInService(file, "postgres", ["pg_isready", "-q"]).status === 0,
  // The Railway Redis image requires auth, so an unauthenticated PING answers
  // `NOAUTH Authentication required.` — which still proves the server is
  // listening and parsing commands. Either reply counts as ready.
  redis: (file) => /PONG|NOAUTH/.test(execInService(file, "redis", ["redis-cli", "ping"]).stdout ?? ""),
};

function isReady(file, service) {
  if (!isRunning(file, service)) return false;
  const check = READY_CHECKS[service];
  return check ? check(file) : true;
}

async function streamLogs(file, service) {
  // `docker compose logs -f` against a service with no container exits straight
  // away instead of waiting, so gate on the container first. In practice the
  // `railway-dev` one-shot has already completed by now; this covers the race.
  const deadline = Date.now() + CONTAINER_WAIT_MS;
  while (!isRunning(file, service)) {
    if (Date.now() > deadline) fail(`container for \`${service}\` never appeared (is \`railway dev\` running?)`);
    await sleep(POLL_INTERVAL_MS);
  }

  const child = spawn("docker", ["compose", "-f", file, "logs", "-f", "--no-log-prefix", "--tail", "100", service], {
    stdio: "inherit",
  });
  // process-compose stops us with SIGTERM/SIGINT; pass it through so the tail
  // detaches cleanly instead of being orphaned.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => process.exit(signal ? 0 : (code ?? 0)));
}

const [command, service] = process.argv.slice(2);
if (!command) fail("usage: railway-containers.mjs <logs|ready|compose-file> [service]");

if (command === "compose-file") {
  console.log(composePath());
} else if (command === "ready") {
  if (!service) fail("usage: railway-containers.mjs ready <service>");
  // A missing compose file means the containers aren't up — not ready, but not
  // worth a hard failure either: process-compose polls this on a loop.
  process.exit(existsSync(composePath()) && isReady(composePath(), service) ? 0 : 1);
} else if (command === "logs") {
  if (!service) fail("usage: railway-containers.mjs logs <service>");
  await streamLogs(composeFile(), service);
} else {
  fail(`unknown command \`${command}\``);
}
