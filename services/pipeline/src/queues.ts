import { Queue } from "bullmq";
import { connectionFor } from "#/redis.ts";
import { PIPELINES } from "#/workflows/index.ts";

// One `Queue` per pipeline definition, built once per process. Only the server
// process needs these — a `Queue` is the producer/inspection handle (add jobs,
// read counts, manage schedulers); a `Worker` opens its own connection and does
// not go through here.
//
// Queues are created lazily so that importing this module has no side effects,
// which is what lets `queues.test.ts` import the registry without a Redis.

let queues: Map<string, Queue> | undefined;

export function getQueues(redisUrl: string): Map<string, Queue> {
  if (!queues) {
    const connection = connectionFor(redisUrl);
    queues = new Map(
      PIPELINES.map((pipeline) => [
        pipeline.name,
        new Queue(pipeline.name, {
          connection,
          defaultJobOptions: pipeline.defaultJobOptions,
        }),
      ]),
    );
  }
  return queues;
}

export function getQueue(redisUrl: string, name: string): Queue | undefined {
  return getQueues(redisUrl).get(name);
}

export async function closeQueues(): Promise<void> {
  if (!queues) return;
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues = undefined;
}
