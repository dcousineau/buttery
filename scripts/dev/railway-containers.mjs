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
// surface each container as its own process-compose service: one `docker logs
// -f` tail per container, plus readiness probes the app processes can wait on.
//
// The docker-compose project name is the Railway project id, which is machine
// local state (`~/.railway/config.json`, keyed by checkout path) and is NOT
// stable across clones — so it is resolved at runtime here rather than
// hardcoded in process-compose.yaml.
//
// Usage:
//   node scripts/dev/railway-containers.mjs logs  <service>   # stream, stays attached
//   node scripts/dev/railway-containers.mjs ready <service>   # exit 0 when serving
//   node scripts/dev/railway-containers.mjs name  <service>   # print container name

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

function containerName(service) {
  return `${projectId()}-${service}-1`;
}

function isRunning(name) {
  const result = spawnSync("docker", ["ps", "--filter", `name=^${name}$`, "--format", "{{.Names}}"], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === name;
}

function execInContainer(name, argv) {
  return spawnSync("docker", ["exec", name, ...argv], { encoding: "utf8" });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Readiness per container. Postgres and Redis get real protocol-level checks so
 * dependents (migrations, the web server) don't race a still-booting server;
 * anything else is considered ready once the container is up.
 */
const READY_CHECKS = {
  postgres: (name) => execInContainer(name, ["pg_isready", "-q"]).status === 0,
  // The Railway Redis image requires auth, so an unauthenticated PING answers
  // `NOAUTH Authentication required.` — which still proves the server is
  // listening and parsing commands. Either reply counts as ready.
  redis: (name) => /PONG|NOAUTH/.test(execInContainer(name, ["redis-cli", "ping"]).stdout ?? ""),
};

function isReady(service, name) {
  if (!isRunning(name)) return false;
  const check = READY_CHECKS[service];
  return check ? check(name) : true;
}

async function streamLogs(service, name) {
  const deadline = Date.now() + CONTAINER_WAIT_MS;
  while (!isRunning(name)) {
    if (Date.now() > deadline) fail(`container ${name} never appeared (is \`railway dev\` running?)`);
    await sleep(POLL_INTERVAL_MS);
  }

  const child = spawn("docker", ["logs", "-f", "--tail", "100", name], { stdio: "inherit" });
  // process-compose stops us with SIGTERM/SIGINT; pass it through so `docker
  // logs` detaches cleanly instead of being orphaned.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => process.exit(signal ? 0 : (code ?? 0)));
}

const [command, service] = process.argv.slice(2);
if (!command || !service) fail("usage: railway-containers.mjs <logs|ready|name> <service>");

const name = containerName(service);
if (command === "name") {
  console.log(name);
} else if (command === "ready") {
  process.exit(isReady(service, name) ? 0 : 1);
} else if (command === "logs") {
  await streamLogs(service, name);
} else {
  fail(`unknown command \`${command}\``);
}
