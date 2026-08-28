import fp from "fastify-plugin";
import { FlowProducer, Queue, Worker, type JobsOptions } from "bullmq";
import { defineWorkflow, type ChildResults, type EnqueueNode, type FlowNode, type Workflow as KernelWorkflow } from "#/lib/bullmq/kernel.ts";
import { jobHost } from "#/lib/bullmq/hosts.ts";

/**
 * The second registration path (S2): `fastify.workflow(spec)`, modelled on
 * the reference's `plugins/sqs.ts` — a `Map` of registrations held in plugin
 * closure, `onReady` starting consumers (here: BullMQ `Worker`s) or
 * reconciling schedules depending on process role, `preClose` draining,
 * `onClose` closing.
 *
 * `defineWorkflow` (D6) still exists in `lib/bullmq/kernel.ts` and three
 * workflows still call it directly — this plugin adds a second path, it does
 * not replace the first. A later step (S3) migrates each workflow, one at a
 * time, to call `fastify.workflow({...})` from inside its own
 * `FastifyPluginAsync` body instead.
 *
 * D5 — steps registered through this path get their dependencies from the
 * enclosing plugin's closure, not from the step context: `ctx.redis` does not
 * exist here the way it does on `kernel.ts`'s `StepContext`. A step that needs
 * Redis reaches `fastify.redis` directly, the same way `handlers/*.ts` in the
 * reference reach `fastify.db("service")`.
 *
 * `WorkflowSpec.close` is deliberately not part of this type (see the plan's
 * "WorkflowSpec.close is deleted, not just emptied" paragraph) — a plugin
 * registered through this path owns its own resources via its own `onClose`,
 * so there is nothing left for a workflow to release on drain.
 *
 * `globalConcurrency` and `schedule` are plain values here, not the
 * `() => value` thunks `kernel.ts`'s `WorkflowSpec` still carries for the old
 * path. Those were functions only so they could read `process.env` lazily,
 * after `.env` load; `fastify.env` is already parsed and frozen by the time
 * any workflow registers, so the indirection has nothing left to do.
 */

/** What a step is handed. Same shape as `kernel.ts`'s `StepContext` minus `redis` (D5). */
export interface StepContext {
  /** Whatever JSON was in Redis — narrow it yourself. */
  payload: unknown;
  runId: string;
  /** Appends a line to this job's log. */
  log: (message: string) => Promise<void>;
  progress: (fraction: number) => Promise<void>;
  /** What this step's children returned; empty if it has none. */
  children: () => Promise<ChildResults>;
  /** Submits one atomic flow: a step, and the steps that must finish first. */
  flow: (node: FlowNode) => Promise<void>;
  /** Hands a job to a different workflow's queue; does not wait on it or join its flow. */
  enqueue: (workflow: string, node: EnqueueNode) => Promise<void>;
}

export interface StepSpec {
  name: string;
  /** One line, shown in `/workflows`. */
  description: string;
  /** Return value becomes the job's result, and its parent's input. */
  run: (ctx: StepContext) => Promise<unknown>;
  /** Per-job retry policy (`attempts`, `backoff`) lives here. */
  jobOptions?: JobsOptions;
}

export interface WorkflowSpec {
  /** Queue name; also the URL segment in `POST /jobs/:queue`. */
  name: string;
  /** One line, shown in `/workflows`, the board and the README. */
  description: string;
  /** The step a bare enqueue runs. */
  entry: string;
  steps: readonly StepSpec[];
  /** Applied under each step's own options. */
  defaultJobOptions?: JobsOptions;
  /** Jobs one worker runs at once from this queue; defaults to `PIPELINE_WORKER_CONCURRENCY`. */
  concurrency?: number;
  /** Max jobs of this workflow active fleet-wide; `undefined` for no cap. */
  globalConcurrency?: number;
  /** Cron pattern (UTC) the entry step runs on; `undefined` for enqueue-only. */
  schedule?: string;
}

/** The three shapes `app.ts` will register this (and every plugin) under (D1). Not wired up until S4. */
export type PipelineRole = "server" | "worker" | "cli";

interface WorkflowPluginOptions {
  role?: PipelineRole;
}

interface Registration {
  spec: WorkflowSpec;
  /** The kernel's runtime dispatch, reused unmodified — see the module doc. */
  workflow: KernelWorkflow;
  queue: Queue;
  /** Only present once `onReady` has built it (role === "worker"). BullMQ's `Worker` has no create-then-start split like `sqs-consumer`'s `Consumer` — construction itself starts fetching. */
  worker?: Worker;
}

/** Prefix keeps schedulers distinguishable from any created by hand in the Bull Board UI. Same convention as `lib/bullmq/reconcile.ts`. */
function schedulerId(queueName: string): string {
  return `${queueName}:scheduled`;
}

declare module "fastify" {
  interface FastifyInstance {
    workflow: (spec: WorkflowSpec) => void;
  }
}

export default fp(
  (fastify, opts: WorkflowPluginOptions) => {
    const registrations = new Map<string, Registration>();
    const flows = new FlowProducer({ connection: fastify.redis });

    fastify.decorate("workflow", (spec: WorkflowSpec) => {
      if (registrations.has(spec.name)) {
        throw new Error(`workflow "${spec.name}" is already registered.`);
      }

      // Adapts to kernel.ts's defineWorkflow to reuse its step-dispatch
      // (name lookup, jobOptionsFor) unmodified. A plugin step's `run` takes
      // fewer fields than kernel's StepContext (no `redis`), so it is
      // structurally assignable wherever kernel's StepContext-typed `run` is
      // expected — no cast needed. `close` is omitted: this path has none.
      const workflow = defineWorkflow({
        name: spec.name,
        description: spec.description,
        entry: spec.entry,
        steps: spec.steps,
        defaultJobOptions: spec.defaultJobOptions,
        concurrency: spec.concurrency,
      });

      const queue = new Queue(spec.name, {
        connection: fastify.redis,
        defaultJobOptions: spec.defaultJobOptions,
      });

      registrations.set(spec.name, { spec, workflow, queue });
    });

    fastify.addHook("onReady", async () => {
      if (opts.role === "worker") {
        const queues = new Map([...registrations].map(([name, r]) => [name, r.queue]));

        for (const registration of registrations.values()) {
          const { spec, workflow } = registration;

          const worker = new Worker(
            spec.name,
            (job) =>
              workflow.run({ step: job.name, payload: job.data, host: jobHost(job, workflow, flows, queues, (name) => registrations.get(name)?.workflow), redis: fastify.redis }),
            {
              connection: fastify.redis,
              concurrency: spec.concurrency ?? fastify.env.PIPELINE_WORKER_CONCURRENCY,
            },
          );

          worker.on("failed", (job, err) => {
            fastify.log.error({ queue: spec.name, jobId: job?.id, name: job?.name, attempt: job?.attemptsMade, err: err.message }, "job failed");
          });

          // A worker that loses Redis logs and keeps retrying; it must not
          // take the process down, or Railway would restart-loop the whole
          // fleet on a blip.
          worker.on("error", (err) => {
            fastify.log.error({ queue: spec.name, err: String(err) }, "worker error");
          });

          registration.worker = worker;
        }
      } else if (opts.role === "server") {
        // Reconcile, not register (see lib/bullmq/reconcile.ts for the same
        // discipline on the old path): schedulers and concurrency caps live in
        // Redis and outlive deployments, so a workflow whose schedule or cap
        // was removed has to have it explicitly torn down here, not just
        // stop having it set.
        for (const { spec, queue } of registrations.values()) {
          if (spec.globalConcurrency) {
            await queue.setGlobalConcurrency(spec.globalConcurrency);
            fastify.log.info({ queue: spec.name, limit: spec.globalConcurrency }, "global concurrency set");
          } else {
            await queue.removeGlobalConcurrency();
          }

          const id = schedulerId(spec.name);
          if (spec.schedule) {
            await queue.upsertJobScheduler(id, { pattern: spec.schedule, tz: "UTC" }, { name: spec.entry });
            fastify.log.info({ queue: spec.name, id, pattern: spec.schedule, tz: "UTC" }, "schedule active");
          } else {
            const removed = await queue.removeJobScheduler(id);
            if (removed) fastify.log.info({ queue: spec.name, id }, "schedule removed");
          }
        }
      }
    });

    // Workers must stop fetching and finish in-flight jobs here, before the
    // pool and Redis close in their own `onClose` — a draining replica must
    // not have a job killed mid-write. `worker.close()` does both: it stops
    // fetching and waits for what is already in flight.
    fastify.addHook("preClose", async () => {
      const workers = [...registrations.values()].flatMap((r) => (r.worker ? [r.worker] : []));
      await Promise.all(workers.map((worker) => worker.close()));
    });

    // By the time this runs every worker above is already fully closed;
    // what is left to release is the producer side: queues and the shared
    // flow producer. Fastify closes plugins in reverse registration order,
    // so this hook — and the drain above — run before `redis`'s own
    // `onClose` quits the client they both depend on.
    fastify.addHook("onClose", async () => {
      await Promise.all([...registrations.values()].map((r) => r.queue.close()));
      await flows.close();
    });
  },
  { name: "workflow", dependencies: ["env", "redis"] },
);
