import { FlowProducer, Queue } from "bullmq";
import { connectionFor } from "#/redis.ts";
import { WORKFLOWS } from "#/workflows/index.ts";

// One `Queue` per workflow, plus the one `FlowProducer` that builds the graphs,
// built once per process.
//
// A `Queue` is the producer/inspection handle: add jobs, read counts, manage
// schedulers. A `FlowProducer` is the same thing for a tree of jobs — it writes
// a parent and its children in one atomic call, so there is never a window where
// half a fan-out exists. Both processes need them: the server to enqueue and
// count, the worker because a step submits the next stage of its own graph.
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

let flows: FlowProducer | undefined;

/** Shared across every workflow: a flow names its queues per node, not per producer. */
export function getFlowProducer(redisUrl: string): FlowProducer {
  flows ??= new FlowProducer({ connection: connectionFor(redisUrl) });
  return flows;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...(queues?.values() ?? [])].map((queue) => queue.close()));
  queues = undefined;
  await flows?.close();
  flows = undefined;
}
