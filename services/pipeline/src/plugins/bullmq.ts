import fp from "fastify-plugin";
import { FlowProducer, Queue, Worker, type JobsOptions, type Processor } from "bullmq";

/**
 * BullMQ's three top-level primitives — `Queue`, `Worker`, `FlowProducer` —
 * owned by Fastify's lifecycle instead of wrapped in a workflow engine.
 *
 * ── WHAT THIS REPLACED, AND WHY ─────────────────────────────────────────────
 *
 * There used to be a `defineWorkflow` kernel here: a `WorkflowSpec` of named
 * `StepSpec`s, a `StepContext` handed to each one, two `WorkflowHost`
 * implementations (`jobHost`, `consoleHost`), and a dispatch layer that turned
 * `job.name` into a step lookup. It was a small workflow engine, and it cost
 * more than it bought:
 *
 *   - Every BullMQ concept arrived renamed. A job was a "step", a queue was a
 *     "workflow", `FlowProducer.add` was `ctx.flow`, `queue.add` on another
 *     queue was `ctx.enqueue`. Reading BullMQ's own docs did not help you read
 *     this codebase, which is the tax a bespoke vocabulary always charges.
 *   - `StepContext` could only offer what the kernel thought to forward. A step
 *     wanting `job.attemptsMade`, `job.discard()`, `job.moveToDelayed()` or
 *     `UnrecoverableError` semantics had to grow the kernel first.
 *   - `consoleHost` re-implemented fan-out in-process so `run-once` could
 *     execute a graph without a worker — a second, subtly different execution
 *     engine whose failure modes nothing in production shared.
 *
 * So: a job is a job. A processor gets the real `Job`, switches on `job.name`,
 * and calls `job.log()`, `job.updateProgress()`, `job.getChildrenValues()`,
 * `job.getIgnoredChildrenFailures()` — BullMQ's own API, documented by BullMQ.
 * Fan-out is `fastify.bullmq.flow.add(...)`. Cross-queue handoff is
 * `queue.add(...)` on the other queue. Nothing is renamed on the way through.
 *
 * ── WHAT THIS PLUGIN STILL DOES ─────────────────────────────────────────────
 *
 * Exactly what a Fastify plugin is for, and nothing else:
 *
 *   - **Lifecycle.** Queues, workers and the flow producer are constructed
 *     against `fastify.redis` and closed in the right order by `preClose`
 *     (drain workers) and `onClose` (close queues and the producer), before
 *     `plugins/redis.ts` closes the client underneath them.
 *   - **Role.** One process registers the same queues whether it produces or
 *     consumes; only `role === "worker"` actually constructs `Worker`s, and
 *     only `role === "server"` reconciles schedulers and concurrency caps.
 *     Registration is declarative; what runs is the role's business.
 *   - **A registry**, because the board, `GET /queues` and `POST /jobs/:queue`
 *     all need to enumerate what exists. It holds the `Queue` plus the display
 *     metadata BullMQ has nowhere to put: a description, and the job names this
 *     queue's processor actually handles.
 *
 * Where Fastify and BullMQ idioms disagree, Fastify wins: dependencies arrive
 * by decorator rather than by import, resources are released by hooks rather
 * than by hand, and a queue is registered from inside a plugin body rather than
 * constructed at module scope.
 */

/** One job name a queue's processor handles. Metadata only — BullMQ has nowhere to hang a description. */
export interface JobDescriptor {
  /** Passed to `queue.add(name, ...)` and matched on `job.name` inside the processor. */
  name: string;
  /** One line, shown in `GET /queues`. */
  description: string;
}

export interface RegisterQueueOptions {
  /** The BullMQ queue name, and the `POST /jobs/:queue` URL segment. */
  name: string;
  /** One line, shown in `GET /queues`, the board and the README. */
  description: string;
  /** Every job name this queue's processor handles. */
  jobs: readonly JobDescriptor[];
  /** What `POST /jobs/:queue` adds when the body names no job, and what a scheduler fires. */
  defaultJob: string;
  /** BullMQ's own per-queue defaults, applied under each `queue.add`'s options. */
  defaultJobOptions?: JobsOptions;
  /** `Queue.setGlobalConcurrency` — max jobs of this queue active fleet-wide. Reconciled by the server role. */
  globalConcurrency?: number;
  /** Cron pattern (UTC) that adds a `defaultJob` job. Reconciled by the server role via `upsertJobScheduler`. */
  schedule?: string;
}

export interface QueueRegistration {
  readonly options: RegisterQueueOptions;
  readonly queue: Queue;
}

export interface BullmqRegistry {
  /** Construct and register a queue. Returns the real `Queue` — add jobs to it directly. */
  queue: (options: RegisterQueueOptions) => Queue;
  /**
   * Register a processor for a queue. The `Worker` is constructed in `onReady`,
   * and only when this process's role is "worker" — BullMQ has no
   * create-then-start split, so constructing one here would make every producer
   * a consumer too.
   */
  worker: (queueName: string, processor: Processor, options?: { concurrency?: number }) => void;
  /** The shared `FlowProducer`. Call `.add()` on it to fan out; children may name any registered queue. */
  readonly flow: FlowProducer;
  get: (name: string) => QueueRegistration | undefined;
  list: () => readonly QueueRegistration[];
}

/** The three shapes a pipeline process takes. */
export type PipelineRole = "server" | "worker" | "cli";

interface BullmqPluginOptions {
  role?: PipelineRole;
}

/** Prefix keeps our schedulers distinguishable from any created by hand in the Bull Board UI. */
function schedulerId(queueName: string): string {
  return `${queueName}:scheduled`;
}

declare module "fastify" {
  interface FastifyInstance {
    bullmq: BullmqRegistry;
  }
}

export default fp(
  (fastify, opts: BullmqPluginOptions) => {
    const registrations = new Map<string, QueueRegistration>();
    const processors = new Map<string, { processor: Processor; concurrency?: number }>();
    const workers: Worker[] = [];
    const flow = new FlowProducer({ connection: fastify.redis });

    fastify.decorate("bullmq", {
      flow,

      queue: (options: RegisterQueueOptions) => {
        if (registrations.has(options.name)) {
          throw new Error(`queue "${options.name}" is already registered.`);
        }
        if (!options.jobs.some((job) => job.name === options.defaultJob)) {
          // Caught here rather than at the first `POST /jobs/:queue`, which is
          // the sort of typo that otherwise surfaces as a job nobody handles
          // sitting in the failed tab.
          throw new Error(`queue "${options.name}" names "${options.defaultJob}" as its default job, which it does not declare.`);
        }

        const queue = new Queue(options.name, {
          connection: fastify.redis,
          defaultJobOptions: options.defaultJobOptions,
        });
        registrations.set(options.name, { options, queue });
        return queue;
      },

      worker: (queueName: string, processor: Processor, workerOptions?: { concurrency?: number }) => {
        if (processors.has(queueName)) {
          throw new Error(`queue "${queueName}" already has a processor.`);
        }
        processors.set(queueName, { processor, concurrency: workerOptions?.concurrency });
      },

      get: (name: string) => registrations.get(name),
      list: () => [...registrations.values()],
    } satisfies BullmqRegistry);

    fastify.addHook("onReady", async () => {
      if (opts.role === "worker") {
        for (const [queueName, { processor, concurrency }] of processors) {
          if (!registrations.has(queueName)) {
            throw new Error(`a processor is registered for queue "${queueName}", which no plugin registered.`);
          }

          const worker = new Worker(queueName, processor, {
            connection: fastify.redis,
            concurrency: concurrency ?? fastify.env.PIPELINE_WORKER_CONCURRENCY,
          });

          worker.on("failed", (job, err) => {
            fastify.log.error({ queue: queueName, jobId: job?.id, name: job?.name, attempt: job?.attemptsMade, err: err.message }, "job failed");
          });

          // A worker that loses Redis logs and keeps retrying; it must not take
          // the process down, or Railway would restart-loop the whole fleet on
          // a blip.
          worker.on("error", (err) => {
            fastify.log.error({ queue: queueName, err: String(err) }, "worker error");
          });

          workers.push(worker);
        }
        return;
      }

      if (opts.role === "server") {
        // Reconcile, not register: schedulers and concurrency caps live in
        // Redis and outlive deployments, so a queue whose schedule or cap was
        // REMOVED has to have it explicitly torn down here, not merely stop
        // being set.
        for (const { options, queue } of registrations.values()) {
          if (options.globalConcurrency) {
            await queue.setGlobalConcurrency(options.globalConcurrency);
            fastify.log.info({ queue: options.name, limit: options.globalConcurrency }, "global concurrency set");
          } else {
            await queue.removeGlobalConcurrency();
          }

          const id = schedulerId(options.name);
          if (options.schedule) {
            await queue.upsertJobScheduler(id, { pattern: options.schedule, tz: "UTC" }, { name: options.defaultJob });
            fastify.log.info({ queue: options.name, id, pattern: options.schedule, tz: "UTC" }, "schedule active");
          } else {
            const removed = await queue.removeJobScheduler(id);
            if (removed) fastify.log.info({ queue: options.name, id }, "schedule removed");
          }
        }
      }
    });

    // Workers stop fetching and finish what is in flight BEFORE the pool and
    // Redis close in their own `onClose` — a draining replica must not have a
    // job killed mid-write. `worker.close()` does both.
    fastify.addHook("preClose", async () => {
      await Promise.all(workers.map((worker) => worker.close()));
    });

    // By now every worker is closed; what is left is the producer side.
    // Fastify closes plugins in reverse registration order, so this runs before
    // `plugins/redis.ts` quits the client they all share.
    fastify.addHook("onClose", async () => {
      await Promise.all([...registrations.values()].map((registration) => registration.queue.close()));
      await flow.close();
    });
  },
  { name: "bullmq", dependencies: ["env", "redis"] },
);
