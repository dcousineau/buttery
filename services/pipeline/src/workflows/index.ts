import type { Job, JobsOptions } from "bullmq";
import { atprotoSyncPipeline } from "#/workflows/atproto-sync/index.ts";
import { demoPipeline } from "#/workflows/demo/index.ts";

/**
 * A pipeline is one BullMQ queue plus the function that drains it. Declaring
 * both together is what keeps the three processes that care about a queue in
 * agreement without a shared constants file drifting from the code:
 *
 *   * `server.ts` builds a `Queue` per definition so the Bull Board UI lists it
 *     and `POST /jobs/:queue` can enqueue into it,
 *   * `worker.ts` builds a `Worker` per definition from `process`,
 *   * `autoscale.ts` sums the backlog across every definition.
 *
 * Adding a pipeline means adding a folder under `workflows/` and one entry to
 * `PIPELINES` below. Nothing else in the service is queue-aware.
 *
 * `process` is deliberately typed against an unparameterized `Job`: a payload
 * arrives as whatever JSON was in Redis, possibly enqueued by an older
 * deployment, so each handler narrows its own `job.data` at the top rather than
 * trusting a generic that proves nothing at runtime.
 */
export interface PipelineDefinition {
  /** Queue name. Also the URL segment in `POST /jobs/:queue`. */
  name: string;
  /** Shown in the `/queues` listing and the README — keep it to one line. */
  description: string;
  /**
   * Applied to every job added to this queue. Retention (`removeOnComplete` /
   * `removeOnFail`) matters more than it looks: BullMQ keeps finished jobs in
   * Redis forever by default, so an unbounded pipeline slowly becomes the
   * largest thing in the instance.
   */
  defaultJobOptions?: JobsOptions;
  /**
   * Jobs one worker process runs at once for this queue. Defaults to the
   * service-wide `PIPELINE_WORKER_CONCURRENCY`. Set it to 1 for a pipeline whose
   * jobs must not interleave *within* a process — and note that is only half the
   * story once there is more than one replica, where a cross-process lock is the
   * only thing that serialises anything (see `lock.ts`).
   */
  concurrency?: number;
  /**
   * Cron pattern (UTC) this pipeline runs on, or `undefined` for "only when
   * something enqueues it". A function rather than a value because it is read
   * from the environment, and module evaluation order should not decide whether
   * that environment has been loaded yet. Reconciled into BullMQ's job
   * schedulers at server boot — see `schedules.ts`.
   */
  schedule?: () => string | undefined;
  process: (job: Job) => Promise<unknown>;
  /** Released when a worker drains: a database pool, an open file, a client. */
  close?: () => Promise<void>;
}

export const PIPELINES: readonly PipelineDefinition[] = [atprotoSyncPipeline, demoPipeline];

export const PIPELINE_NAMES: readonly string[] = PIPELINES.map((p) => p.name);

export function findPipeline(name: string): PipelineDefinition | undefined {
  return PIPELINES.find((p) => p.name === name);
}
