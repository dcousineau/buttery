import { fileURLToPath } from "node:url";
import { DefaultLogger, NativeConnection, Runtime, Worker } from "@temporalio/worker";
import { loadConfig } from "#/config.ts";
import { log, setLogRole } from "#/log.ts";
import { activities } from "#/workflows/activities.ts";
import { closeWorkflowResources, WORKFLOW_NAMES } from "#/workflows/index.ts";

/**
 * The worker: one process, polling one task queue, running every workflow and
 * activity this build knows about.
 *
 * This is the only long-running service in the package, and it is deliberately
 * anonymous — no HTTP, no state, nothing kept between tasks — because that is
 * the precondition for Railway adding and removing replicas underneath it. A
 * removed replica is drained rather than killed: `shutdownGraceTime` gives
 * in-flight activities time to finish, and anything that does not finish is
 * retried on another replica, which is what activities are for.
 *
 * Compared with the BullMQ build, three processes collapse into this one. There
 * is no producer service (a client starts workflows; nothing has to be up to
 * hold the queue), no dashboard to run and secure (the Temporal UI is a service
 * of the cluster), and no autoscaler (a worker pulls work when it has capacity,
 * so a backlog waits in Temporal rather than piling into a process — and adding
 * replicas is a number in the IaC, not a control loop with a Railway API token).
 */

setLogRole("worker");

// The SDK's own logs — poll failures, task timeouts, shutdown — through this
// service's JSON logger, so a Railway log stream has one format in it and not
// two. Must happen before the first Worker.create: that is what installs the
// runtime, and the runtime picks up whatever logger exists at that moment.
Runtime.install({
  logger: new DefaultLogger("INFO", (entry) => {
    const level = entry.level === "ERROR" || entry.level === "WARN" ? (entry.level.toLowerCase() as "error" | "warn") : "info";
    log[level](entry.message, { ...entry.meta, sdk: true });
  }),
});

const config = loadConfig();

const connection = await NativeConnection.connect({
  address: config.temporal.address,
  tls: config.temporal.tls,
  apiKey: config.temporal.apiKey,
});

let worker: Worker | undefined;
try {
  worker = await Worker.create({
    connection,
    namespace: config.temporal.namespace,
    taskQueue: config.temporal.taskQueue,

    // Workflow code is bundled — not imported — because it runs in a
    // deterministic isolate rather than in this process. The bundle is built at
    // boot, which costs a few seconds of startup and buys the ability to run the
    // repo's TypeScript as-is, with no build step anywhere in this service.
    workflowsPath: fileURLToPath(new URL("./workflows/bundle.ts", import.meta.url)),

    // Activities, by contrast, are ordinary functions in this process, with
    // `pg`, `fetch` and the environment all available to them.
    activities,

    maxConcurrentActivityTaskExecutions: config.worker.maxConcurrentActivityTaskExecutions,
    maxConcurrentWorkflowTaskExecutions: config.worker.maxConcurrentWorkflowTaskExecutions,
    shutdownGraceTime: config.worker.shutdownGraceTimeMs,
  });

  log.info("worker ready", {
    address: config.temporal.address,
    namespace: config.temporal.namespace,
    taskQueue: config.temporal.taskQueue,
    workflows: WORKFLOW_NAMES,
    activities: Object.keys(activities).length,
  });

  // Installs SIGINT/SIGTERM handlers of its own and resolves once the worker has
  // drained, so there is nothing to wire up here: the shutdown path is `await`.
  await worker.run();
  log.info("worker drained");
} catch (err) {
  log.error("worker failed", { err: String(err) });
  process.exitCode = 1;
} finally {
  await connection.close();
  // Pools the activities opened. Without this the process lingers with an idle
  // pg pool holding the event loop open, and Railway waits out its whole drain
  // window on every deploy.
  await closeWorkflowResources();
}
