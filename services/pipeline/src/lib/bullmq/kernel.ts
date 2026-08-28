import type { FlowJob, JobsOptions } from "bullmq";
import type { Redis } from "ioredis";

/**
 * A workflow is one BullMQ queue and the steps that drain it: a step is a
 * job, and children wait on each other via BullMQ flows (see `flow()`).
 */

/** A node in a flow: one step, plus whatever must finish before it. */
export interface FlowNode {
  step: string;
  data?: unknown;
  /** Merged over the step's own `jobOptions`. */
  opts?: JobsOptions;
  /** Jobs that must all settle before this one runs. */
  children?: readonly FlowNode[];
}

/** One job, handed to a workflow other than this one. No `children` — crossing queues means no flow atomicity. */
export interface EnqueueNode {
  /** Defaults to the target workflow's `entry`. */
  step?: string;
  data?: unknown;
  /** Merged over the *target* step's own `jobOptions` — see `hosts.ts`. */
  opts?: JobsOptions;
}

/** What the children of a step returned, once they have all settled. */
export interface ChildResults {
  /** In no particular order. */
  values: unknown[];
  /** Messages from children that exhausted their attempts. */
  failures: string[];
}

/** What a step is handed. */
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
  redis: Redis;
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
  globalConcurrency?: () => number | undefined;
  /** Cron pattern (UTC) the entry step runs on; `undefined` for enqueue-only. */
  schedule?: () => string | undefined;
  /** Released when a worker drains: a pool, a file, a client. */
  close?: () => Promise<void>;
}

/** What a step reports to and submits flows through. Two implementations in `hosts.ts`. */
export interface WorkflowHost {
  runId: string;
  log: (message: string) => Promise<void>;
  progress: (fraction: number) => Promise<void>;
  children: () => Promise<ChildResults>;
  flow: (node: FlowNode) => Promise<void>;
  enqueue: (workflow: string, node: EnqueueNode) => Promise<void>;
}

export interface WorkflowRun {
  /** Defaults to the workflow's entry step. */
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
  jobOptionsFor: (step: string) => JobsOptions | undefined;
  run: (run: WorkflowRun) => Promise<unknown>;
}

/** Turns a node into what `FlowProducer.add` wants, recursively. */
export function flowJobFor(workflow: Workflow, queueName: string, node: FlowNode, isChild: boolean): FlowJob {
  return {
    name: node.step,
    queueName,
    data: node.data ?? {},
    opts: {
      ...workflow.jobOptionsFor(node.step),
      // Children get ignoreDependencyOnFailure so a failed child is stepped over, not fatal to its parent; applied before node.opts so a step can override it.
      ...(isChild ? { ignoreDependencyOnFailure: true } : {}),
      ...node.opts,
    },
    children: node.children?.map((child) => flowJobFor(workflow, queueName, child, true)),
  };
}

export function defineWorkflow(spec: WorkflowSpec): Workflow {
  const byName = new Map(spec.steps.map((step) => [step.name, step]));
  if (!byName.has(spec.entry)) {
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
