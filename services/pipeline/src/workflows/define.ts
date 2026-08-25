import type { FlowJob, JobsOptions } from "bullmq";
import type { Redis } from "ioredis";

/**
 * The workflow kernel: what a workflow is, and what running one means.
 *
 * A **workflow** is one BullMQ queue and the **steps** that drain it. A step is
 * a job — not a phase inside one — and a workflow is the graph those jobs form:
 * a step declares the work that must finish before it runs, and BullMQ keeps it
 * in `waiting-children` until that work has. That graph is a
 * [flow](https://docs.bullmq.io/guide/flows), which is BullMQ's own name for the
 * shape, and `flow()` below is the only thing in this service that builds one.
 *
 * One job per step, rather than one job per workflow, is what makes each step
 * its own unit of:
 *
 *   * **retry** — a step declares its own `attempts` and backoff, so a repo
 *     whose PDS times out costs that repo its retries and nobody else's work;
 *   * **failure** — a child that exhausts its attempts is stepped over and
 *     counted by its parent, instead of taking the whole run down;
 *   * **distribution** — every step goes through the queue, so a fleet of
 *     workers shares them instead of one worker looping alone; and
 *   * **visibility** — the board shows each step as a job, with its own payload,
 *     log, duration, return value and place in the tree.
 *
 * A step that is waiting on children occupies no worker while it waits, which is
 * the property that makes fanning a sweep out over thousands of repos reasonable
 * rather than a way to pin a process for an hour.
 *
 * The whole graph lives on **one queue**, named for the workflow, with the job's
 * `name` naming the step. Flows can span queues and sometimes should; keeping
 * one workflow's steps together means the board groups them, `/queues` counts
 * them as one backlog, and adding a step does not add a deployment concern.
 */

/** A node in a flow: one step, plus whatever must finish before it. */
export interface FlowNode {
  /** Which step this job runs. */
  step: string;
  data?: unknown;
  /** Merged over the step's own `jobOptions`. */
  opts?: JobsOptions;
  /** Jobs that must all settle before this one runs. */
  children?: readonly FlowNode[];
}

/**
 * One job, handed to a workflow other than this one. There is no `children`
 * here on purpose: BullMQ's atomic multi-job write is `FlowProducer.add`, and
 * that builds a tree on **one** queue. `enqueue` crosses queues, so it cannot
 * offer that atomicity or that waiting relationship — it is `queue.add`, not a
 * flow, and the shape says so.
 */
export interface EnqueueNode {
  /** Which step the target workflow runs. Defaults to that workflow's `entry`. */
  step?: string;
  data?: unknown;
  /** Merged over the *target* step's own `jobOptions` — see `hosts.ts`. */
  opts?: JobsOptions;
}

/** What the children of a step returned, once they have all settled. */
export interface ChildResults {
  /** Return values of the children that completed, in no particular order. */
  values: unknown[];
  /** Messages from the children that exhausted their attempts and were stepped over. */
  failures: string[];
}

/** What a step is handed. */
export interface StepContext {
  /** This job's data. Narrow it — it is whatever JSON was in Redis. */
  payload: unknown;
  /** Identifies this job in the service's own logs. */
  runId: string;
  /** A line in this job's log, visible in the board's per-job log tab. */
  log: (message: string) => Promise<void>;
  /** 0..1, for a step long enough that a bar means something. */
  progress: (fraction: number) => Promise<void>;
  /**
   * What this step's children returned. Available to any step that has some;
   * empty for a step with none.
   */
  children: () => Promise<ChildResults>;
  /**
   * Submit downstream work: a step, and the steps that must finish first. One
   * call, one flow — BullMQ creates the whole tree atomically, so there is no
   * window where half a fan-out exists.
   *
   * Children are created with `ignoreDependencyOnFailure`, which is what "the
   * parent counts the failure and carries on" means: a child that fails for good
   * leaves the parent's dependencies instead of failing it. A step that wants
   * the opposite says so with `opts.failParentOnFailure`.
   */
  flow: (node: FlowNode) => Promise<void>;
  /**
   * Hand one job to a **different** workflow's queue. `flow()` builds a graph
   * inside this workflow's own queue — a parent that waits on it, retries that
   * belong to this run. `enqueue` deliberately cannot do either: a cross-workflow
   * handoff must never become a flow child, because a step that waited on
   * thousands of another workflow's jobs would hold whatever this run's own
   * lock or schedule depends on for as long as that other workflow took to
   * drain. `atproto-sync`'s `finalize` is the motivating case — it must not
   * wait on the enrichment jobs it hands off, or the next scheduled sweep would
   * find the lock still held and skip itself (D13,
   * `docs/plans/2026-08-20-recipe-enrichment.md`). The target workflow gets its
   * own run, its own retries, its own place on the board — this step neither
   * waits for it nor hears back.
   */
  enqueue: (workflow: string, node: EnqueueNode) => Promise<void>;
  /** For a step that needs one — `lock.ts`, chiefly. */
  redis: Redis;
}

export interface StepSpec {
  /** Names the step, and names the jobs that run it. */
  name: string;
  /** One line, shown in `/workflows`. */
  description: string;
  /** The work. What it returns is the job's return value, and its parent's input. */
  run: (ctx: StepContext) => Promise<unknown>;
  /**
   * Applied to every job of this step. This is where a step's retry policy lives:
   * `attempts` and `backoff` are per-job in BullMQ, which is exactly what makes a
   * step a retry boundary of its own.
   */
  jobOptions?: JobsOptions;
}

export interface WorkflowSpec {
  /** Queue name. Also the URL segment in `POST /jobs/:queue`. */
  name: string;
  /** Shown in `/workflows`, the board and the README — keep it to one line. */
  description: string;
  /** The step a bare enqueue runs: the root of the graph, and what the schedule fires. */
  entry: string;
  steps: readonly StepSpec[];
  /**
   * Applied to every job on this queue, under each step's own options. Retention
   * (`removeOnComplete` / `removeOnFail`) matters more than it looks: BullMQ keeps
   * finished jobs in Redis forever by default, and a fanned-out workflow produces
   * a job per item, so an unbounded queue becomes the largest thing in the
   * instance faster than you would expect.
   */
  defaultJobOptions?: JobsOptions;
  /**
   * Jobs one worker process runs at once from this queue. Defaults to the
   * service-wide `PIPELINE_WORKER_CONCURRENCY`. It covers every step, since they
   * share a queue — size it for the step there are most of.
   */
  concurrency?: number;
  /**
   * The most jobs of this workflow that may be **active at once across the whole
   * fleet**, or `undefined` for no cap. A function for the same reason `schedule`
   * is one: it is read from the environment. Reconciled into the queue's meta at
   * server boot — see `reconcile.ts`, which explains why this and a worker's
   * `concurrency` are different limits and why a fan-out needs this one.
   *
   * It covers every step, since they share a queue. That is usually what you
   * want — the step there are thousands of is the one worth bounding — and it
   * cannot deadlock a graph: a step waiting on children is not active, so it
   * holds no slot while it waits.
   */
  globalConcurrency?: () => number | undefined;
  /**
   * Cron pattern (UTC) the entry step runs on, or `undefined` for "only when
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
 * What a step reports to, and submits flows through. Two implementations
 * (`hosts.ts`): a BullMQ job, and a terminal for the one-shot CLI. The kernel
 * talks to this instead of to `Job` so that running a workflow by hand is the
 * same code path as running it from the queue, rather than a second one that can
 * quietly diverge.
 */
export interface WorkflowHost {
  runId: string;
  log: (message: string) => Promise<void>;
  progress: (fraction: number) => Promise<void>;
  children: () => Promise<ChildResults>;
  flow: (node: FlowNode) => Promise<void>;
  enqueue: (workflow: string, node: EnqueueNode) => Promise<void>;
}

export interface WorkflowRun {
  /** Which step to run. A job's `name`; defaults to the workflow's entry step. */
  step?: string;
  payload: unknown;
  host: WorkflowHost;
  redis: Redis;
}

/** A workflow, as the registry and the four processes that read it see one. */
export interface Workflow {
  name: string;
  description: string;
  entry: string;
  steps: readonly { name: string; description: string }[];
  defaultJobOptions?: JobsOptions;
  concurrency?: number;
  globalConcurrency?: () => number | undefined;
  schedule?: () => string | undefined;
  close?: () => Promise<void>;
  /** Job options for one step, for whoever is creating the job. */
  jobOptionsFor: (step: string) => JobsOptions | undefined;
  run: (run: WorkflowRun) => Promise<unknown>;
}

/**
 * Turn a node into what `FlowProducer.add` wants, recursively. Exported for the
 * console host, which walks the same tree without a Redis under it.
 */
export function flowJobFor(workflow: Workflow, queueName: string, node: FlowNode, isChild: boolean): FlowJob {
  return {
    name: node.step,
    queueName,
    data: node.data ?? {},
    opts: {
      ...workflow.jobOptionsFor(node.step),
      // A child that fails for good is stepped over, not fatal to its parent.
      // Last, so a step that means the opposite can say so in its own options.
      ...(isChild ? { ignoreDependencyOnFailure: true } : {}),
      ...node.opts,
    },
    children: node.children?.map((child) => flowJobFor(workflow, queueName, child, true)),
  };
}

export function defineWorkflow(spec: WorkflowSpec): Workflow {
  const byName = new Map(spec.steps.map((step) => [step.name, step]));
  if (!byName.has(spec.entry)) {
    // A typo here would otherwise surface as a 404 from an hourly schedule at
    // three in the morning. Module load is a better time to find out.
    throw new Error(`workflow "${spec.name}" names "${spec.entry}" as its entry step, which it does not define`);
  }

  return {
    name: spec.name,
    description: spec.description,
    entry: spec.entry,
    steps: spec.steps.map((step) => ({ name: step.name, description: step.description })),
    defaultJobOptions: spec.defaultJobOptions,
    concurrency: spec.concurrency,
    globalConcurrency: spec.globalConcurrency,
    schedule: spec.schedule,
    close: spec.close,
    jobOptionsFor: (step) => byName.get(step)?.jobOptions,
    run: async (run) => {
      const name = run.step ?? spec.entry;
      const step = byName.get(name);
      if (!step) {
        // Reachable in exactly one way: a job enqueued by a deployment that had
        // a step this one does not. Failing loudly beats silently doing nothing.
        throw new Error(`workflow "${spec.name}" has no step "${name}"`);
      }
      return step.run({
        payload: run.payload,
        runId: run.host.runId,
        log: run.host.log,
        progress: run.host.progress,
        children: run.host.children,
        flow: run.host.flow,
        enqueue: run.host.enqueue,
        redis: run.redis,
      });
    },
  };
}
