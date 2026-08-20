import type { JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import { withLock } from "#/lock.ts";
import { log } from "#/log.ts";

/**
 * The workflow kernel: what a pipeline is, and what running one means.
 *
 * A **workflow** is one BullMQ queue plus an ordered list of **steps** that
 * drain it. Both halves are declared in one place — `defineWorkflow` — because
 * three processes have to agree about a queue and none of them should learn
 * about it from a constants file that can drift:
 *
 *   * `server.ts` builds a `Queue` per workflow, so the Bull Board UI lists it
 *     and `POST /jobs/:queue` can enqueue into it,
 *   * `worker.ts` builds a `Worker` per workflow and hands each job to `run`,
 *   * `autoscale.ts` sums the backlog across every queue there is.
 *
 * Steps are BullMQ's own vocabulary, not an invention here: the library's
 * documented pattern for a job with phases is to keep a cursor in the job's data
 * and switch on it, so an interrupted job picks up where it left off instead of
 * starting over. This module is that pattern with the bookkeeping factored out —
 * each step gets its progress slice, its log lines and its share of the cursor
 * for free, and a workflow file is left holding only the work.
 *
 * What steps buy, in the order they matter:
 *
 *   1. A job stops being opaque. The board shows which of five named phases a
 *      sweep is in, how long each took, and which one a failure came out of.
 *   2. Progress is real. The runner advances the job through the steps, so the
 *      bar in the UI means something without a workflow computing percentages.
 *   3. A retry can resume — see `resumeOnRetry`, which is off by default because
 *      it is only sound for some workflows.
 *
 * Not a BullMQ *flow* (`FlowProducer`, parent/child jobs across queues). A flow
 * is the right shape for fan-out where each child is worth its own job, its own
 * retry and its own place in the backlog. The steps of one sweep are none of
 * those: they are strictly sequential, they share an in-memory context, and
 * turning the per-repo loop into thousands of child jobs would multiply Redis
 * traffic and drown the autoscaler's queue-depth signal in bookkeeping.
 */

/**
 * Where the step cursor lives inside a job's data. Reserved: a payload of its
 * own with this key would be overwritten. `$` keeps it visually separate from
 * the payload in the board's data tab.
 */
export const STEP_CURSOR_KEY = "$step";

/** What a step is handed. Everything else it needs comes from `state`. */
export interface StepContext<S> {
  /**
   * The run's working memory, built once by `start()` and threaded through every
   * step. In-memory only — it is NOT persisted between attempts (see
   * `resumeOnRetry`).
   */
  state: S;
  /** A line in this job's log, visible in the board's per-job log tab. */
  log: (message: string) => Promise<void>;
  /**
   * Progress *within this step*, 0..1. The runner scales it into the job's
   * overall progress, so a step never needs to know how many steps there are.
   * Optional: a step that reports nothing still advances the bar when it ends.
   */
  progress: (fraction: number) => Promise<void>;
}

export interface Step<S> {
  /** Stable identifier. It is the cursor value, so renaming one ends a resume. */
  name: string;
  run: (ctx: StepContext<S>) => Promise<void>;
}

export interface WorkflowSpec<S> {
  /** Queue name. Also the URL segment in `POST /jobs/:queue`. */
  name: string;
  /** Shown in `/workflows`, the board and the README — keep it to one line. */
  description: string;
  /**
   * Build the run's working memory from the job payload. This is where a
   * workflow parses `job.data`: a payload is whatever JSON was in Redis, possibly
   * enqueued by an older deployment, so it is narrowed here rather than trusted
   * through a generic that proves nothing at runtime.
   */
  start: (payload: unknown) => S | Promise<S>;
  /** Run in order. Each one owns a phase; none of them own the plumbing. */
  steps: readonly Step<S>[];
  /**
   * What the job returns — shown in the board's job detail. Without it a job
   * completes with `undefined`. Never return `state` wholesale: it usually holds
   * configuration, and configuration usually holds a connection string.
   */
  result?: (state: S) => unknown;
  /**
   * Called when a step throws, before the error propagates. For releasing or
   * finalizing whatever earlier steps opened — a database row marked `running`
   * that would otherwise stay that way forever. It cannot swallow the failure;
   * the original error is always rethrown.
   */
  onFailure?: (state: S, err: unknown) => Promise<void>;
  /**
   * Resume at the cursor when a retry picks the job back up, instead of running
   * from the first step.
   *
   * Off by default, and the default is the safe one. `state` is rebuilt by
   * `start()` on every attempt, so resuming skips the steps that would have
   * filled it in — which is only correct when each step can work from `start()`'s
   * state plus whatever earlier steps wrote somewhere durable. A workflow whose
   * steps hand each other data in memory must restart, and most do.
   */
  resumeOnRetry?: boolean;
  /**
   * Hold this Redis key for the length of a run, fleet-wide. A run that cannot
   * take the lock SKIPS — it completes with `{ status: "skipped" }` rather than
   * failing, because the work is already being done and failing would only buy a
   * retry that hits the same lock.
   *
   * BullMQ stops the *same* job running twice; it does not stop two *different*
   * jobs on one queue, which is exactly what a schedule plus a long job plus two
   * replicas produces. See `lock.ts`.
   */
  exclusive?: { key: string; ttlMs: number };
  /**
   * Applied to every job added to this queue. Retention (`removeOnComplete` /
   * `removeOnFail`) matters more than it looks: BullMQ keeps finished jobs in
   * Redis forever by default, so an unbounded queue slowly becomes the largest
   * thing in the instance.
   */
  defaultJobOptions?: JobsOptions;
  /**
   * Jobs one worker process runs at once for this queue. Defaults to the
   * service-wide `PIPELINE_WORKER_CONCURRENCY`. Set it to 1 for a workflow whose
   * jobs must not interleave *within* a process — and note that is only half the
   * story once there is more than one replica, where `exclusive` is the only
   * thing that serialises anything.
   */
  concurrency?: number;
  /**
   * Cron pattern (UTC) this workflow runs on, or `undefined` for "only when
   * something enqueues it". A function rather than a value because it is read
   * from the environment, and module evaluation order should not decide whether
   * that environment has been loaded yet. Reconciled into BullMQ's job schedulers
   * at server boot — see `schedules.ts`.
   */
  schedule?: () => string | undefined;
  /** Released when a worker drains: a database pool, an open file, a client. */
  close?: () => Promise<void>;
}

/**
 * What a run reports to. Two implementations (`hosts.ts`): a BullMQ job, and a
 * console for the one-shot CLI. The kernel talks to this instead of to `Job` so
 * that running a workflow by hand is the same code path as running it from the
 * queue, rather than a second one that can quietly diverge.
 */
export interface WorkflowHost {
  /** Identifies this run in the service's own logs. */
  runId: string;
  log: (message: string) => Promise<void>;
  /** Overall progress, 0..1. */
  progress: (fraction: number) => Promise<void>;
  /** The persisted step cursor, or `undefined` if there is none / none is possible. */
  readCursor: () => string | undefined;
  writeCursor: (step: string) => Promise<void>;
}

export interface WorkflowRun {
  payload: unknown;
  host: WorkflowHost;
  /** For `exclusive`. Both drivers already have a client; neither opens one here. */
  redis: Redis;
}

/**
 * A workflow, with its state type erased. The registry holds these, so nothing
 * downstream of `defineWorkflow` is generic — the state type lives entirely
 * inside the closure `defineWorkflow` builds.
 */
export interface Workflow {
  name: string;
  description: string;
  /** Step names in order, for `/workflows` and the docs. */
  steps: readonly string[];
  defaultJobOptions?: JobsOptions;
  concurrency?: number;
  schedule?: () => string | undefined;
  close?: () => Promise<void>;
  run: (run: WorkflowRun) => Promise<unknown>;
}

/** Returned instead of a result when `exclusive` is held by another run. */
export const SKIPPED = { status: "skipped" } as const;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 1);
}

async function runSteps<S>(spec: WorkflowSpec<S>, run: WorkflowRun): Promise<unknown> {
  const { host } = run;
  const steps = spec.steps;

  let first = 0;
  const cursor = spec.resumeOnRetry ? host.readCursor() : undefined;
  if (cursor) {
    const at = steps.findIndex((step) => step.name === cursor);
    if (at >= 0) {
      first = at;
      await host.log(`resuming at step "${cursor}"`);
    } else {
      // A deployment renamed or removed the step this job was on. Starting over
      // is the only defensible reading — guessing an index would run the wrong
      // work, and failing would strand a job nothing can retry.
      await host.log(`step cursor "${cursor}" is not a step of this workflow — starting over`);
    }
  }

  const state = await spec.start(run.payload);

  for (let i = first; i < steps.length; i++) {
    const step = steps[i];
    if (spec.resumeOnRetry) await host.writeCursor(step.name);

    const startedAt = Date.now();
    await host.log(`step ${i + 1}/${steps.length} "${step.name}" started`);

    try {
      await step.run({
        state,
        log: (message) => host.log(`  [${step.name}] ${message}`),
        progress: (fraction) => host.progress((i + clamp01(fraction)) / steps.length),
      });
    } catch (err) {
      // Naming the step here, rather than wrapping the error, is deliberate: the
      // board's failed tab shows `err.message` and the original stack, and a
      // wrapper would cost both to add a word the log line already carries.
      await host.log(`step "${step.name}" FAILED: ${String(err)}`);
      log.error("workflow step failed", { workflow: spec.name, run: host.runId, step: step.name, err: String(err) });
      if (spec.onFailure) {
        await spec.onFailure(state, err).catch((cleanupErr: unknown) => {
          // A failed cleanup must not replace the failure that caused it.
          log.error("workflow onFailure hook failed", { workflow: spec.name, run: host.runId, err: String(cleanupErr) });
        });
      }
      throw err;
    }

    await host.progress((i + 1) / steps.length);
    await host.log(`step "${step.name}" done in ${Date.now() - startedAt}ms`);
  }

  return spec.result ? spec.result(state) : undefined;
}

export function defineWorkflow<S>(spec: WorkflowSpec<S>): Workflow {
  return {
    name: spec.name,
    description: spec.description,
    steps: spec.steps.map((step) => step.name),
    defaultJobOptions: spec.defaultJobOptions,
    concurrency: spec.concurrency,
    schedule: spec.schedule,
    close: spec.close,
    run: async (run) => {
      if (!spec.exclusive) return runSteps(spec, run);

      // Boxed, because `withLock` returns undefined both for "someone else holds
      // it" and for "ran, returned undefined" — and a workflow with no `result`
      // does exactly the latter.
      const held = await withLock(run.redis, spec.exclusive.key, { ttlMs: spec.exclusive.ttlMs }, async () => ({
        value: await runSteps(spec, run),
      }));

      if (!held) {
        await run.host.log(`skipped: another run of "${spec.name}" holds the lock`);
        log.warn("workflow run skipped — another run holds the lock", { workflow: spec.name, run: run.host.runId });
        return SKIPPED;
      }
      return held.value;
    },
  };
}
