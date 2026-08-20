import type { Queue } from "bullmq";
import { PIPELINES } from "#/workflows/index.ts";
import { log } from "#/log.ts";

/**
 * Reconcile BullMQ's job schedulers with what the pipelines declare.
 *
 * A job scheduler is BullMQ's replacement for the old repeatable jobs: one
 * durable record in Redis that produces the next job on a cron pattern, kept
 * alive by whichever worker is around. It is what makes "run this hourly" a
 * property of the queue rather than of a container that has to stay up — which
 * is the whole reason a cron *service* is no longer needed.
 *
 * Reconcile, not register: schedulers live in Redis and outlive deployments, so
 * a pipeline whose schedule was removed has to have its scheduler deleted or it
 * keeps firing forever, driven by a config nothing in the repo mentions any
 * more. Turning a schedule off in the environment must actually turn it off.
 *
 * The server does this at boot — it is the one process there is exactly one of.
 * Doing it from the workers would have every replica race to upsert the same
 * scheduler on every scale-up.
 */

/** Prefix keeps our schedulers distinguishable from any created by hand in the UI. */
function schedulerId(queueName: string): string {
  return `${queueName}:scheduled`;
}

export async function reconcileSchedules(queues: Map<string, Queue>): Promise<void> {
  for (const pipeline of PIPELINES) {
    const queue = queues.get(pipeline.name);
    if (!queue) continue;

    const id = schedulerId(pipeline.name);
    const pattern = pipeline.schedule?.();

    if (!pattern) {
      const removed = await queue.removeJobScheduler(id);
      if (removed) log.info("schedule removed", { queue: pipeline.name, id });
      continue;
    }

    // Idempotent: upserting the same pattern leaves the existing scheduler and
    // its next run alone, so a redeploy does not reset the clock. Everything is
    // UTC — the Railway cron this replaces was too, and a schedule that quietly
    // shifts twice a year with a server's local DST is its own kind of bug.
    await queue.upsertJobScheduler(id, { pattern, tz: "UTC" }, { name: pipeline.name });
    log.info("schedule active", { queue: pipeline.name, id, pattern, tz: "UTC" });
  }
}
