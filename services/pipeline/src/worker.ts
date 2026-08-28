import type { FastifyInstance } from "fastify";
import { buildApp } from "#/app.ts";

/**
 * The `pipeline-worker` service: one `Worker` per workflow, nothing else.
 *
 * It runs no HTTP server and holds no state between jobs, which is what makes it
 * safe for Railway to add and remove replicas underneath it (see
 * `autoscale.ts`). Every replica runs this same file and competes for the same
 * queues; BullMQ's Redis-side locking is what keeps a job from being handled
 * twice. A fanned-out workflow is what makes that worth having: the repos of one
 * sweep are thousands of independent jobs, and the fleet splits them.
 *
 * `concurrency` and replica count are two different dials. Concurrency is how
 * many jobs one process interleaves — right for I/O-bound work, useless for
 * CPU-bound work, since it is all one event loop. Replicas add actual CPUs.
 *
 * The `Worker` construction, its `failed`/`error` listeners and the drain on
 * shutdown all live in `plugins/workflow.ts` now — `onReady` builds a `Worker`
 * per registration when `role === "worker"` (which is why `app.ready()` below
 * is what actually starts consuming), and `preClose` closes them before this
 * process's Redis connection goes away.
 */

// Hoisted so the top-level `.catch()` below — which runs when `buildApp`
// itself rejects, before a Fastify instance exists to log through — can still
// tell whether one got far enough to be built.
let builtApp: FastifyInstance | undefined;

async function start(): Promise<void> {
  const app = await buildApp("worker");
  builtApp = app;
  // Builds the Workers — see `plugins/workflow.ts`'s `onReady` hook.
  await app.ready();

  app.log.info(
    {
      queues: app.workflows.list().map((registration) => registration.spec.name),
    },
    "pipeline worker started",
  );

  // Graceful drain. `app.close()` runs `plugins/workflow.ts`'s `preClose` hook
  // first, which calls `worker.close()` on every registration — stopping new
  // fetches and waiting for in-flight jobs to finish — before its `onClose`
  // closes queues, the flow producer, Redis and the pool. Exactly what a
  // scale-down needs: Railway drains a removed replica rather than killing it,
  // so a job in progress finishes instead of being re-delivered after its lock
  // expires. A worker that loses Redis logs and keeps retrying (see the
  // `error` listener in `plugins/workflow.ts`); it must not take the process
  // down, or Railway would restart-loop the whole fleet on a blip.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "draining workers");
    await app.close();
    app.log.info({ signal }, "workers drained");
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void shutdown(signal).catch((err: unknown) => {
        app.log.error({ err: String(err) }, "drain failed");
        process.exit(1);
      });
    });
  }
}

await start().catch((err: unknown) => {
  // No Fastify instance if `buildApp` itself is what rejected.
  if (builtApp) builtApp.log.error({ err: String(err) }, "pipeline worker failed to start");
  else console.error("pipeline worker failed to start", err);
  process.exit(1);
});
