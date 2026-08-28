import type { Queue } from "bullmq";

/**
 * Queue depth, read straight from Redis. This is the load signal the autoscaler
 * runs on and the payload `GET /queues` returns.
 *
 * Railway does not expose per-replica utilisation through its API, so the usable
 * signal has to come from inside the application. For a worker fleet that signal
 * is queue depth: it is the thing more replicas actually fix, it is measured in
 * one place rather than sampled per replica, and it needs no cooperation from
 * the workers themselves.
 */

export interface QueueBacklog {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  /** What the autoscaler divides by `backlogPerReplica`. See below. */
  pending: number;
}

export interface BacklogSnapshot {
  queues: QueueBacklog[];
  /** Sum of every queue's `pending`. */
  pending: number;
}

export async function readBacklog(queues: Iterable<Queue>): Promise<BacklogSnapshot> {
  const results = await Promise.all(
    [...queues].map(async (queue): Promise<QueueBacklog> => {
      const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed");
      const waiting = counts.waiting ?? 0;
      const active = counts.active ?? 0;
      return {
        name: queue.name,
        waiting,
        active,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        completed: counts.completed ?? 0,
        // `waiting + active` and nothing else. `delayed` is excluded on purpose:
        // a job scheduled for 3am is not work the fleet can do now, and counting
        // it would hold replicas open all night for a queue that is idle. Failed
        // and completed are history, not load.
        pending: waiting + active,
      };
    }),
  );

  return {
    queues: results,
    pending: results.reduce((sum, q) => sum + q.pending, 0),
  };
}
