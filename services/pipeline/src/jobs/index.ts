import type { Job, JobsOptions } from "bullmq";
import { demoPipeline } from "#/jobs/demo.ts";

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
 * Adding a pipeline means adding a file under `jobs/` and one entry to
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
  process: (job: Job) => Promise<unknown>;
}

export const PIPELINES: readonly PipelineDefinition[] = [demoPipeline];

export const PIPELINE_NAMES: readonly string[] = PIPELINES.map((p) => p.name);

export function findPipeline(name: string): PipelineDefinition | undefined {
  return PIPELINES.find((p) => p.name === name);
}
