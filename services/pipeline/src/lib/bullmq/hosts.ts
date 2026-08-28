import type { FlowProducer, Job, Queue } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { flowJobFor, type ChildResults, type EnqueueNode, type FlowNode, type Workflow, type WorkflowHost } from "#/lib/bullmq/kernel.ts";

/** The two things a step can report to and submit flows through: a BullMQ job, and a terminal for the one-shot CLI. */

const NO_CHILDREN: ChildResults = { values: [], failures: [] };

/**
 * `resolve` is how a step's `enqueue` finds the workflow it is targeting. It is
 * an argument rather than a module-level registry lookup because there are now
 * two registries — the old `WORKFLOWS` array and the workflow plugin's own Map
 * — and this module must not know which one its caller lives in. It also keeps
 * `lib/bullmq/` from importing out of `workflows/`, which was backwards.
 */
export function jobHost(job: Job, workflow: Workflow, flows: FlowProducer, queues: Map<string, Queue>, resolve: (name: string) => Workflow | undefined): WorkflowHost {
  return {
    runId: `job:${job.id ?? "?"}`,
    log: async (message) => {
      await job.log(message);
    },
    progress: (fraction) => job.updateProgress(Math.round(Math.min(Math.max(fraction, 0), 1) * 100)),

    children: async () => {
      const [values, failures] = await Promise.all([job.getChildrenValues(), job.getIgnoredChildrenFailures()]);
      return { values: Object.values(values), failures: Object.values(failures) };
    },

    flow: async (node: FlowNode) => {
      await flows.add(flowJobFor(workflow, workflow.name, node, false));
    },

    enqueue: async (targetName: string, node: EnqueueNode) => {
      const target = resolve(targetName);
      if (!target) {
        throw new Error(`ctx.enqueue: no workflow named "${targetName}"`);
      }
      const stepName = node.step ?? target.entry;
      if (!target.steps.some((s) => s.name === stepName)) {
        throw new Error(`ctx.enqueue: workflow "${targetName}" has no step "${stepName}"`);
      }
      const queue = queues.get(targetName);
      if (!queue) {
        throw new Error(`ctx.enqueue: no queue for workflow "${targetName}"`);
      }
      await queue.add(stepName, node.data ?? {}, {
        // Target workflow's own job options for this step, not the caller's.
        ...target.jobOptionsFor(stepName),
        ...node.opts,
      });
    },
  };
}

/** For `run-once.ts`: no queue to submit a flow to, so the tree runs here — children first, `concurrency` at a time. */
export interface ConsoleHostOptions {
  workflow: Workflow;
  /** Supplied by `run-once.ts`, which owns the wiring. */
  runStep: (step: string, payload: unknown, children: ChildResults) => Promise<unknown>;
  concurrency: number;
  /** `run-once.ts`'s `app.log` — this host has no Fastify instance of its own. */
  log: FastifyBaseLogger;
}

export function consoleHost(options: ConsoleHostOptions, children: ChildResults = NO_CHILDREN): WorkflowHost {
  const { workflow, log } = options;

  const line = (message: string): Promise<void> => {
    log.info({ workflow: workflow.name }, message.trim());
    return Promise.resolve();
  };

  return {
    runId: "cli",
    log: line,
    progress: () => Promise.resolve(),
    children: () => Promise.resolve(children),

    flow: async (node: FlowNode) => {
      const values: unknown[] = [];
      const failures: string[] = [];
      const kids = node.children ?? [];

      let next = 0;
      const runners = Array.from({ length: Math.min(options.concurrency, kids.length) }, async () => {
        while (next < kids.length) {
          const child = kids[next++];
          try {
            values.push(await runNode(child));
          } catch (err) {
            failures.push(String(err));
            log.error({ workflow: workflow.name, step: child.step, err: String(err) }, "step failed");
          }
        }
      });
      await Promise.all(runners);

      await options.runStep(node.step, node.data ?? {}, { values, failures });
    },

    enqueue: async (targetName: string, node: EnqueueNode) => {
      // Logs the intent and does not run the target workflow, deliberately.
      await line(`enqueue: ${targetName}${node.step ? `/${node.step}` : ""} — skipped (run "${targetName}" directly to execute it)`);
    },
  };

  /** One node, its own children first. Throws, so its parent can count it. */
  async function runNode(node: FlowNode): Promise<unknown> {
    if (!node.children?.length) {
      return options.runStep(node.step, node.data ?? {}, NO_CHILDREN);
    }
    const values = await Promise.all(node.children.map((child) => runNode(child)));
    return options.runStep(node.step, node.data ?? {}, { values, failures: [] });
  }
}
