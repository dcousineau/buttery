import { Worker } from "bullmq";
import { loadConfig } from "#/config.ts";
import { PIPELINES } from "#/jobs/index.ts";
import { log, setLogRole } from "#/log.ts";
import { closeRedis, connectionFor } from "#/redis.ts";

setLogRole("worker");

/**
 * The `pipeline-worker` service: one `Worker` per pipeline, nothing else.
 *
 * It runs no HTTP server and holds no state between jobs, which is what makes it
 * safe for Railway to add and remove replicas underneath it (see
 * `autoscale.ts`). Every replica runs this same file and competes for the same
 * queues; BullMQ's Redis-side locking is what keeps a job from being handled
 * twice.
 *
 * `concurrency` and replica count are two different dials. Concurrency is how
 * many jobs one process interleaves — right for I/O-bound work, useless for
 * CPU-bound work, since it is all one event loop. Replicas add actual CPUs.
 */

function start(): void {
  const config = loadConfig();
  const connection = connectionFor(config.redisUrl);

  const workers = PIPELINES.map((pipeline) => {
    const worker = new Worker(pipeline.name, (job) => pipeline.process(job), {
      connection,
      concurrency: pipeline.concurrency ?? config.worker.concurrency,
    });

    worker.on("failed", (job, err) => {
      log.error("job failed", {
        queue: pipeline.name,
        jobId: job?.id,
        name: job?.name,
        attempt: job?.attemptsMade,
        err: err.message,
      });
    });

    // A worker that loses Redis logs and keeps retrying; it must not take the
    // process down, or Railway would restart-loop the whole fleet on a blip.
    worker.on("error", (err) => {
      log.error("worker error", { queue: pipeline.name, err: String(err) });
    });

    return worker;
  });

  log.info("pipeline worker started", {
    queues: PIPELINES.map((p) => p.name),
    concurrency: config.worker.concurrency,
  });

  // Graceful drain. `worker.close()` stops fetching new jobs and waits for the
  // in-flight ones, which is exactly what a scale-down needs: Railway drains a
  // removed replica rather than killing it, so a job in progress finishes
  // instead of being re-delivered after its lock expires.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("draining workers", { signal });
    await Promise.all(workers.map((worker) => worker.close()));
    // Only after every in-flight job has finished: a pipeline's `close` releases
    // what its jobs were still using (a pg pool, chiefly).
    await Promise.all(PIPELINES.map((pipeline) => pipeline.close?.() ?? Promise.resolve()));
    await closeRedis();
    log.info("workers drained", { signal });
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void shutdown(signal).catch((err: unknown) => {
        log.error("drain failed", { err: String(err) });
        process.exit(1);
      });
    });
  }
}

try {
  start();
} catch (err) {
  log.error("pipeline worker failed to start", { err: String(err) });
  process.exit(1);
}
