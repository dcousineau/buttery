import type { Queue } from "bullmq";
import { WORKFLOWS } from "#/workflows/index.ts";
import { log } from "#/log.ts";

/**
 * Reconcile what lives in Redis with what the workflows declare: their schedules,
 * and their fleet-wide concurrency caps.
 *
 * A job scheduler is BullMQ's replacement for the old repeatable jobs: one
 * durable record in Redis that produces the next job on a cron pattern, kept
 * alive by whichever worker is around. It is what makes "run this hourly" a
 * property of the queue rather than of a container that has to stay up — which
 * is the whole reason a cron *service* is no longer needed.
 *
 * Reconcile, not register: schedulers live in Redis and outlive deployments, so
 * a workflow whose schedule was removed has to have its scheduler deleted or it
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

export async function reconcileQueues(queues: Map<string, Queue>): Promise<void> {
  await Promise.all([reconcileSchedules(queues), reconcileConcurrency(queues)]);
}

/**
 * The fleet-wide work-in-progress cap: the most jobs of a queue that may be
 * active at once across every worker there is.
 *
 * This is the limit that has no other home. A worker's `concurrency` bounds one
 * process, which is the right knob for protecting a machine and the wrong one
 * for saying "do not point fifty requests at the atmosphere from this sweep" —
 * that number has to hold across replicas, and the autoscaler moves the replica
 * count around underneath it.
 *
 * It is also why nothing in this service throttles a producer. A step fans out
 * every job it has at once and the queue holds them; how many run is this,
 * enforced in Redis, and a queue that is a buffer is the whole point of having
 * one.
 *
 * Same reconcile-not-register discipline as the schedules below: the value lives
 * in the queue's meta hash and outlives deployments, so a workflow that stops
 * declaring a cap has to have it removed.
 */
async function reconcileConcurrency(queues: Map<string, Queue>): Promise<void> {
  for (const workflow of WORKFLOWS) {
    const queue = queues.get(workflow.name);
    if (!queue) continue;

    const limit = workflow.globalConcurrency?.();
    if (!limit) {
      await queue.removeGlobalConcurrency();
      continue;
    }
    await queue.setGlobalConcurrency(limit);
    log.info("global concurrency set", { queue: workflow.name, limit });
  }
}

async function reconcileSchedules(queues: Map<string, Queue>): Promise<void> {
  for (const workflow of WORKFLOWS) {
    const queue = queues.get(workflow.name);
    if (!queue) continue;

    const id = schedulerId(workflow.name);
    const pattern = workflow.schedule?.();

    if (!pattern) {
      const removed = await queue.removeJobScheduler(id);
      if (removed) log.info("schedule removed", { queue: workflow.name, id });
      continue;
    }

    // Idempotent: upserting the same pattern leaves the existing scheduler and
    // its next run alone, so a redeploy does not reset the clock. Everything is
    // UTC — the Railway cron this replaces was too, and a schedule that quietly
    // shifts twice a year with a server's local DST is its own kind of bug.
    // The job's name is the step it runs, so a schedule fires the graph's root.
    await queue.upsertJobScheduler(id, { pattern, tz: "UTC" }, { name: workflow.entry });
    log.info("schedule active", { queue: workflow.name, id, pattern, tz: "UTC" });
  }
}
