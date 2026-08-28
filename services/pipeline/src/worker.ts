import { buildApp } from "#/app.ts";

/**
 * The `pipeline-worker` service: one BullMQ `Worker` per queue, nothing else.
 *
 * It runs no HTTP server and holds no state between jobs, which is what makes it
 * safe for Railway to add and remove replicas underneath it (see
 * `lib/railway/autoscale.ts`). Every replica runs this same file and competes for the same
 * queues; BullMQ's Redis-side locking is what keeps a job from being handled
 * twice. A fanned-out flow is what makes that worth having: the repos of one
 * sweep are thousands of independent jobs, and the fleet splits them.
 *
 * `concurrency` and replica count are two different dials. Concurrency is how
 * many jobs one process interleaves — right for I/O-bound work, useless for
 * CPU-bound work, since it is all one event loop. Replicas add actual CPUs.
 *
 * The `Worker` construction, its `failed`/`error` listeners and the drain on
 * shutdown all live in `plugins/bullmq.ts` — `onReady` builds one `Worker` per
 * registered processor when `role === "worker"` (which is why `app.ready()`
 * below is what actually starts consuming), and `preClose` closes them before
 * this process's Redis connection goes away. BullMQ has no create-then-start
 * split: constructing a `Worker` starts it fetching, which is exactly why the
 * producer roles must never construct one.
 */

async function start(): Promise<void> {
  const app = await buildApp("worker");
  // Builds the Workers — see `plugins/bullmq.ts`'s `onReady` hook.
  await app.ready();

  app.log.info(
    {
      queues: app.bullmq.list().map((registration) => registration.options.name),
    },
    "pipeline worker started",
  );

  // Graceful drain. `app.close()` runs `plugins/bullmq.ts`'s `preClose` hook
  // first, which calls `worker.close()` on every registration — stopping new
  // fetches and waiting for in-flight jobs to finish — before its `onClose`
  // closes queues, the flow producer, Redis and the pool. Exactly what a
  // scale-down needs: Railway drains a removed replica rather than killing it,
  // so a job in progress finishes instead of being re-delivered after its lock
  // expires. A worker that loses Redis logs and keeps retrying (see the
  // `error` listener in `plugins/bullmq.ts`); it must not take the process
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

await start();
