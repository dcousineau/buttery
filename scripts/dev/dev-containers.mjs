#!/usr/bin/env node
/* global process, console, setTimeout */
// ^ The repo's eslint config targets the bundled app, where Node globals come
// from the type-checker. This file is plain JS run directly by Node, so
// `no-undef` needs them declared here (flat config dropped `/* eslint-env */`).
//
// Bridge between the local dev containers (docker-compose.yml at the repo root)
// and process-compose.
//
// `docker compose up -d` starts Postgres/Redis as detached containers and
// exits. That gives process-compose nothing to supervise, so we surface each
// container as its own process-compose service: one log tail per container,
// plus readiness probes the app processes can wait on.
//
// Everything here goes through `docker compose -f <compose file>` rather than
// `docker <cmd> <container-name>`, for one specific reason: `docker logs -f`
// dies the moment its container restarts — AND exits 0, so process-compose
// records the tail as `Completed` rather than failed and leaves it dead. The
// containers ship with `restart: unless-stopped`, so that happens on any crash,
// and a dead `postgres`/`redis` tail takes its readiness probe with it — which
// is what `web` gates on, so the web server can then never come back. `docker
// compose logs -f` follows the *service* and reattaches across both restarts
// and full recreates.
//
// The compose file is committed at the repo root and carries only throwaway
// local-only credentials on fixed, repo-owned ports — see its header. Nothing
// here is machine-local or resolved at runtime anymore (the old `railway dev`
// version had to hunt down a generated file in `~/.railway/develop/…`).
//
// Usage:
//   node scripts/dev/dev-containers.mjs logs  <service>   # stream, stays attached
//   node scripts/dev/dev-containers.mjs ready <service>   # exit 0 when serving
//   node scripts/dev/dev-containers.mjs compose-file      # print the resolved path

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** How long `logs` waits for its container to appear before giving up. */
const CONTAINER_WAIT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

/** Repo root == two levels up from scripts/dev/. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function fail(message) {
  console.error(`dev-containers: ${message}`);
  process.exit(1);
}

/** The committed compose file at the repo root. */
function composePath() {
  return join(REPO_ROOT, "docker-compose.yml");
}

/**
 * Resolved compose file, or bail. It is committed, so absence means a broken
 * checkout rather than "run some setup command first".
 */
function composeFile() {
  const path = composePath();
  if (!existsSync(path)) fail(`no compose file at ${path} — is the checkout intact?`);
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
 * dependents (migrations, the web server) don't race a still-booting server.
 *
 * These run *inside* the container, so they say nothing about whether the app
 * can reach the server — see `hostPort` below.
 */
const READY_CHECKS = {
  postgres: (file) => execInService(file, "postgres", ["pg_isready", "-q"]).status === 0,
  // The Redis image requires auth, so an unauthenticated PING answers
  // `NOAUTH Authentication required.` — which still proves the server is
  // listening and parsing commands. Either reply counts as ready.
  redis: (file) => /PONG|NOAUTH/.test(execInService(file, "redis", ["redis-cli", "ping"]).stdout ?? ""),
};

/**
 * Container port each service listens on. Presence here means the app talks to
 * it over `localhost`, so readiness has to include the published host mapping.
 */
const SERVICE_PORTS = { postgres: 5432, redis: 6379 };

/**
 * Host port the compose file published for a service, or null if it published
 * none. The committed file always publishes both (fixed 55432 / 56379), so a
 * null here means the container isn't up rather than a missing `ports:` key.
 */
function hostPort(file, service) {
  const container = SERVICE_PORTS[service];
  if (!container) return null;
  // `docker compose port` prints `invalid IP:0` and still exits 0 when there's
  // no mapping, so trust the output shape rather than the status code.
  const match = /:(\d+)\s*$/.exec((compose(file, ["port", service, String(container)]).stdout ?? "").trim());
  const port = match ? Number(match[1]) : 0;
  return port > 0 ? port : null;
}

/** Can something on this machine actually open a connection to that port? */
function hostReachable(port, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const settle = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

async function isReady(file, service) {
  if (!isRunning(file, service)) return false;
  const check = READY_CHECKS[service];
  if (check && !check(file)) return false;
  if (!(service in SERVICE_PORTS)) return true;

  const port = hostPort(file, service);
  return port !== null && (await hostReachable(port));
}

async function streamLogs(file, service) {
  // `docker compose logs -f` against a service with no container exits straight
  // away instead of waiting, so gate on the container first. In practice the
  // `dev-containers` one-shot has already completed by now; this covers the race.
  const deadline = Date.now() + CONTAINER_WAIT_MS;
  while (!isRunning(file, service)) {
    if (Date.now() > deadline) fail(`container for \`${service}\` never appeared (did \`docker compose up\` fail?)`);
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
if (!command) fail("usage: dev-containers.mjs <logs|ready|compose-file> [service]");

if (command === "compose-file") {
  console.log(composePath());
} else if (command === "ready") {
  if (!service) fail("usage: dev-containers.mjs ready <service>");
  // A missing compose file means the containers aren't up — not ready, but not
  // worth a hard failure either: process-compose polls this on a loop.
  process.exit(existsSync(composePath()) && (await isReady(composePath(), service)) ? 0 : 1);
} else if (command === "logs") {
  if (!service) fail("usage: dev-containers.mjs logs <service>");
  await streamLogs(composeFile(), service);
} else {
  fail(`unknown command \`${command}\``);
}
