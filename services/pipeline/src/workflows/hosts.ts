import type { FlowProducer, Job } from "bullmq";
import { log } from "#/log.ts";
import { flowJobFor, type ChildResults, type FlowNode, type Workflow, type WorkflowHost } from "#/workflows/define.ts";

/**
 * The two things a step can report to and submit flows through: a BullMQ job,
 * and a terminal.
 *
 * Both go through `Workflow.run`, so a sweep started by the scheduler and one
 * started by `sync:once` execute the same steps in the same order. What differs
 * is where the log lines land, and what submitting a flow means — which is the
 * one place the two genuinely diverge (see `consoleHost`).
 */

const NO_CHILDREN: ChildResults = { values: [], failures: [] };

export function jobHost(job: Job, workflow: Workflow, flows: FlowProducer): WorkflowHost {
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
