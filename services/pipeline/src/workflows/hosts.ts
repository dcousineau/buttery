import type { FlowProducer, Job, Queue } from "bullmq";
import { log } from "#/log.ts";
import { flowJobFor, type ChildResults, type EnqueueNode, type FlowNode, type Workflow, type WorkflowHost } from "#/workflows/define.ts";
import { findWorkflow } from "#/workflows/index.ts";

/**
 * The two things a step can report to and submit flows through: a BullMQ job,
 * and a terminal.
 *
 * Both go through `Workflow.run`, so a sweep started by the scheduler and one
 * started by `sync:once` execute the same steps in the same order. What differs
 * is where the log lines land, and what submitting a flow means — which is the
 * one place the two genuinely diverge (see `consoleHost`) — and now what
 * `enqueue` does: `jobHost` actually hands the job to the target workflow's
 * queue, `consoleHost` only says so (see below).
 *
 * `jobHost` importing `findWorkflow` from `workflows/index.ts` is not a cycle:
 * nothing that module reaches — the workflow definitions themselves — imports
 * this one back. Only `worker.ts`, `run-once.ts` and `define.test.ts` import
 * `hosts.ts`, and none of those sit between `workflows/index.ts` and here.
 */

const NO_CHILDREN: ChildResults = { values: [], failures: [] };

export function jobHost(job: Job, workflow: Workflow, flows: FlowProducer, queues: Map<string, Queue>): WorkflowHost {
  return {
    runId: `job:${job.id ?? "?"}`,
    // `job.log` resolves to the log's new length; the kernel wants nothing back.
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
      const target = findWorkflow(targetName);
      if (!target) {
        // Same reasoning as defineWorkflow's entry-step check: a typo in the
        // target name must fail loudly at the call that made it, not vanish
        // into a queue that was never drained because it never existed.
        throw new Error(`ctx.enqueue: no workflow named "${targetName}"`);
      }
      const stepName = node.step ?? target.entry;
      if (!target.steps.some((s) => s.name === stepName)) {
        throw new Error(`ctx.enqueue: workflow "${targetName}" has no step "${stepName}"`);
      }
      const queue = queues.get(targetName);
      if (!queue) {
        // Reachable only if a workflow is registered but `getQueues()` was
        // built before it was added — a `queues.ts` bug, not a caller mistake.
        throw new Error(`ctx.enqueue: no queue for workflow "${targetName}"`);
      }
      await queue.add(stepName, node.data ?? {}, {
        // The *target* workflow's own job options for that step, not the
        // calling workflow's — this job runs as one of the target's, on the
        // target's queue, and should retry and expire the way the target's
        // other jobs of that step do.
        ...target.jobOptionsFor(stepName),
        ...node.opts,
      });
    },
  };
}

/**
 * For `run-once.ts`. Submitting a flow has no queue to submit to, so the tree
 * runs here, in this process: children first — `concurrency` at a time, because
 * that is what the fleet would have done — then the step that was waiting on
 * them, with their results.
 *
 * That is the one real difference between the two hosts, and it is the honest
 * one: a queue is how work reaches other machines, and a shell command has no
 * other machines. Which steps run, in what order, on what data, and what each
 * one computes are identical.
 */
export interface ConsoleHostOptions {
  workflow: Workflow;
  /** Runs one step here. Supplied by `run-once.ts`, which owns the wiring. */
  runStep: (step: string, payload: unknown, children: ChildResults) => Promise<unknown>;
  concurrency: number;
}

export function consoleHost(options: ConsoleHostOptions, children: ChildResults = NO_CHILDREN): WorkflowHost {
  const { workflow } = options;

  const line = (message: string): Promise<void> => {
    log.info(message.trim(), { workflow: workflow.name });
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
            // Grandchildren are somebody's children too — one recursion covers
            // any depth, the same way `FlowProducer.add` does.
            values.push(await runNode(child));
          } catch (err) {
            // The same bargain the queue makes: one child's failure is counted
            // and stepped over, not the end of the run.
            failures.push(String(err));
            log.error("step failed", { workflow: workflow.name, step: child.step, err: String(err) });
          }
        }
      });
      await Promise.all(runners);

      await options.runStep(node.step, node.data ?? {}, { values, failures });
    },

    enqueue: async (targetName: string, node: EnqueueNode) => {
      // Log the intent and stop — do not run the target workflow. Cross-workflow
      // work is another workflow's run, not this one's: `run-once.ts` promises
      // that the steps *this* workflow owns run identically to the queued path,
      // not that everything reachable from them does. Actually executing the
      // target here would make `sync:once` silently perform a corpus-wide
      // recipe-enrichment backfill on whoever's laptop happened to run a sync —
      // exactly the kind of surprise a one-shot CLI must not spring. A person
      // who wants the target workflow's work done runs it themselves.
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
