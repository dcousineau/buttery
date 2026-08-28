import { Worker } from "bullmq";
import { loadConfig } from "#/config.ts";
import { WORKFLOWS, findWorkflow } from "#/workflows/index.ts";
import { jobHost } from "#/lib/bullmq/hosts.ts";
import { log, setLogRole } from "#/log.ts";
import { closeQueues, getFlowProducer, getQueues } from "#/queues.ts";
import { closeRedis, connectionFor, getRedis } from "#/redis.ts";

setLogRole("worker");

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
 */

function start(): void {
  const config = loadConfig();
  const connection = connectionFor(config.redisUrl);
  // The same shared client BullMQ is using. Workflows that declare `exclusive`
  // take their lock on it, so nothing here opens a second socket.
  const redis = getRedis(config.redisUrl);
  // A step submits the next stage of its own graph, so a worker is a producer
  // too — of flows, not of plain jobs.
  const flows = getFlowProducer(config.redisUrl);
  // A step can also hand work to a *different* workflow's queue (`ctx.enqueue`,
  // `workflows/define.ts`) — `jobHost` needs every workflow's queue, not just
  // its own, to resolve one by name.
  const queues = getQueues(config.redisUrl);

  const workers = WORKFLOWS.map((workflow) => {
    // A job's name is the step it runs; the kernel looks it up and calls it.
    const worker = new Worker(workflow.name, (job) => workflow.run({ step: job.name, payload: job.data, host: jobHost(job, workflow, flows, queues, findWorkflow), redis }), {
      connection,
      concurrency: workflow.concurrency ?? config.worker.concurrency,
    });

    worker.on("failed", (job, err) => {
      log.error("job failed", {
        queue: workflow.name,
        jobId: job?.id,
        name: job?.name,
        attempt: job?.attemptsMade,
        err: err.message,
      });
    });

    // A worker that loses Redis logs and keeps retrying; it must not take the
    // process down, or Railway would restart-loop the whole fleet on a blip.
    worker.on("error", (err) => {
      log.error("worker error", { queue: workflow.name, err: String(err) });
    });

    return worker;
  });

  log.info("pipeline worker started", {
    queues: WORKFLOWS.map((workflow) => workflow.name),
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
    // Only after every in-flight job has finished: a workflow's `close` releases
    // what its jobs were still using (a pg pool, chiefly).
    await Promise.all(WORKFLOWS.map((workflow) => workflow.close?.() ?? Promise.resolve()));
    await closeQueues();
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
