import { fileURLToPath } from "node:url";
import { DefaultLogger, NativeConnection, Runtime, Worker } from "@temporalio/worker";
import { Pool } from "pg";
import { createActivities } from "#/activities.ts";
import { loadConfig } from "#/config.ts";
import { log } from "#/log.ts";
import * as workflows from "#/workflows.ts";

/**
 * The worker: one process, polling one task queue, running every workflow and
 * activity this build knows about.
 *
 * It is deliberately anonymous — no HTTP, no state, nothing kept between tasks —
 * which is the precondition for running more than one of it. A draining worker
 * finishes its in-flight activities before exiting, and anything that does not
 * finish is retried elsewhere.
 *
 * Confirm what it registered from outside, once it is up:
 *
 *   temporal task-queue describe --namespace buttery --task-queue buttery
 */

// The SDK's own logs — poll failures, task timeouts, shutdown — through this
// service's JSON logger, so a log stream has one format in it and not two. Must
// happen before the first Worker.create: that call installs the runtime, and the
// runtime picks up whatever logger exists at that moment.
Runtime.install({
  logger: new DefaultLogger("INFO", (entry) => {
    const level = entry.level === "ERROR" || entry.level === "WARN" ? (entry.level.toLowerCase() as "error" | "warn") : "info";
    log[level](entry.message, { ...entry.meta, sdk: true });
  }),
});

const config = loadConfig();

// The worker owns the pool and hands it to the activities, rather than each
// activity module keeping a lazily-created singleton. It is also what closes it:
// an open pool keeps the event loop alive, and a container that will not exit is
// a deploy that hangs.
const pool = new Pool({ connectionString: config.databaseUrl });
const activities = createActivities({ pool });

const connection = await NativeConnection.connect({
  address: config.address,
  tls: config.tls,
  apiKey: config.apiKey,
});

try {
  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,

    // Workflow code is bundled — not imported — because it runs in a
    // deterministic isolate rather than in this process. The bundle is built at
    // boot, which costs a few seconds of startup and buys running the repo's
    // TypeScript as-is, with no build step anywhere in this service.
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),

    // Activities, by contrast, are ordinary functions in this process, with
    // `pg`, `fetch` and the environment all available to them.
    activities,

    maxConcurrentActivityTaskExecutions: config.maxConcurrentActivityTaskExecutions,
    maxConcurrentWorkflowTaskExecutions: config.maxConcurrentWorkflowTaskExecutions,
    shutdownGraceTime: config.shutdownGraceTimeMs,
  });

  log.info("worker ready", {
    address: config.address,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    // The workflow types a client can start against this queue, and the
    // activities they can call. Printed because there is no API that answers
    // "what did this worker register" — `temporal task-queue describe` shows
    // that a worker is polling, not what it knows how to run.
    workflows: Object.keys(workflows),
    activities: Object.keys(activities),
  });

  // Installs SIGINT/SIGTERM handlers of its own and resolves once the worker has
  // drained, so the shutdown path here is just `await`.
  await worker.run();
  log.info("worker drained");
} catch (err) {
  log.error("worker failed", { err: String(err) });
  process.exitCode = 1;
} finally {
  await connection.close();
  await pool.end();
}
