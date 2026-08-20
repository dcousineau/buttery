import { Queue } from "bullmq";
import { connectionFor } from "#/redis.ts";
import { WORKFLOWS } from "#/workflows/index.ts";

// One `Queue` per workflow, built once per process. Only the server
// process needs these — a `Queue` is the producer/inspection handle (add jobs,
// read counts, manage schedulers); a `Worker` opens its own connection and does
// not go through here.
//
// Queues are created lazily so that importing this module has no side effects —
// the workflow registry can be imported (by a test, by the CLI) without anything
// reaching for a Redis.

let queues: Map<string, Queue> | undefined;

export function getQueues(redisUrl: string): Map<string, Queue> {
  if (!queues) {
    const connection = connectionFor(redisUrl);
    queues = new Map(
      WORKFLOWS.map((workflow) => [
        workflow.name,
        new Queue(workflow.name, {
          connection,
          defaultJobOptions: workflow.defaultJobOptions,
        }),
      ]),
    );
  }
  return queues;
}

export async function closeQueues(): Promise<void> {
  if (!queues) return;
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues = undefined;
}
