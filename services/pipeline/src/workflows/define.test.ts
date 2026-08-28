import type { FlowProducer, Job } from "bullmq";
import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { consoleHost, jobHost } from "#/lib/bullmq/hosts.ts";
import { defineWorkflow, flowJobFor, type ChildResults, type EnqueueNode, type StepSpec, type Workflow, type WorkflowHost } from "#/lib/bullmq/kernel.ts";

/**
 * The kernel, on its own. Everything here is in-memory: the console host runs a
 * graph in this process, so the ordering and folding rules every workflow
 * inherits are pinned without a Redis under them.
 */

const NO_REDIS = {} as Redis;
const EMPTY: ChildResults = { values: [], failures: [] };

/** Runs a whole graph the way `run-once.ts` does. Returns the entry step's value. */
function runInline(workflow: Workflow, payload: unknown = {}): Promise<unknown> {
  const runStep = (step: string, data: unknown, children: ChildResults): Promise<unknown> =>
    workflow.run({
      step,
      payload: data,
      host: consoleHost({ workflow, runStep, concurrency: 4 }, children),
      redis: NO_REDIS,
    });
  return runStep(workflow.entry, payload, EMPTY);
}

function step(name: string, run: StepSpec["run"], jobOptions?: StepSpec["jobOptions"]): StepSpec {
  return { name, description: name, run, jobOptions };
}

describe("defineWorkflow", () => {
  it("refuses to define a workflow whose entry step does not exist", () => {
    expect(() =>
      defineWorkflow({
        name: "broken",
        description: "",
        entry: "nope",
        steps: [step("real", () => Promise.resolve())],
      }),
    ).toThrow(/names "nope" as its entry step/);
  });

  it("dispatches a job to the step its name picks out", async () => {
    const workflow = defineWorkflow({
      name: "test",
      description: "",
      entry: "one",
      steps: [step("one", () => Promise.resolve("first")), step("two", () => Promise.resolve("second"))],
    });

    await expect(workflow.run({ step: "two", payload: {}, host: consoleHost({ workflow, runStep: () => Promise.resolve(), concurrency: 1 }), redis: NO_REDIS })).resolves.toBe(
      "second",
    );
  });

  it("fails loudly on a job naming a step this build does not have", async () => {
    const workflow = defineWorkflow({ name: "test", description: "", entry: "one", steps: [step("one", () => Promise.resolve())] });

    await expect(workflow.run({ step: "gone", payload: {}, host: consoleHost({ workflow, runStep: () => Promise.resolve(), concurrency: 1 }), redis: NO_REDIS })).rejects.toThrow(
      /has no step "gone"/,
    );
  });

  describe("the graph", () => {
    /** entry fans out `n` children, then a parent that folds what they returned. */
    function fanOutWorkflow(onChild: (index: number) => Promise<unknown>) {
      const ran: string[] = [];
      const workflow = defineWorkflow({
        name: "test",
        description: "",
        entry: "start",
        steps: [
          step("start", async ({ payload, flow }) => {
            const count = (payload as { count?: number }).count ?? 3;
            await flow({
              step: "collect",
              data: { count },
              children: Array.from({ length: count }, (_, i) => ({ step: "work", data: { index: i } })),
            });
            return "dispatched";
          }),
          step("work", ({ payload }) => {
            const index = (payload as { index: number }).index;
            ran.push(`work:${index}`);
            return onChild(index);
          }),
          step("collect", async ({ children }) => {
            ran.push("collect");
            const results = await children();
            return { completed: results.values.length, failed: results.failures.length };
          }),
        ],
      });
      return { workflow, ran };
    }

    it("runs every child before the step waiting on them", async () => {
      const { workflow, ran } = fanOutWorkflow((i) => Promise.resolve(i));
      await runInline(workflow, { count: 3 });

      expect(ran.filter((r) => r.startsWith("work:"))).toHaveLength(3);
      expect(ran.at(-1)).toBe("collect");
    });

    it("counts a child that failed for good and carries on", async () => {
      const collected: unknown[] = [];
      const { workflow } = fanOutWorkflow((i) => (i === 1 ? Promise.reject(new Error("child boom")) : Promise.resolve(i)));

      // The entry step returns its own value; the fold is what the parent saw.
      const runStep = (s: string, data: unknown, children: ChildResults): Promise<unknown> =>
        workflow.run({ step: s, payload: data, host: consoleHost({ workflow, runStep, concurrency: 4 }, children), redis: NO_REDIS }).then((value) => {
          if (s === "collect") collected.push(value);
          return value;
        });
      await runStep(workflow.entry, { count: 3 }, EMPTY);

      expect(collected).toEqual([{ completed: 2, failed: 1 }]);
    });
  });

  describe("flowJobFor", () => {
    const workflow = defineWorkflow({
      name: "test",
      description: "",
      entry: "parent",
      steps: [step("parent", () => Promise.resolve(), { attempts: 1 }), step("child", () => Promise.resolve(), { attempts: 5 })],
    });

    it("gives every node its step's job options, and keeps the whole tree on one queue", () => {
      const tree = flowJobFor(workflow, "test", { step: "parent", children: [{ step: "child" }] }, false);

      expect(tree.queueName).toBe("test");
      expect(tree.opts?.attempts).toBe(1);
      expect(tree.children?.[0].queueName).toBe("test");
      expect(tree.children?.[0].opts?.attempts).toBe(5);
    });

    it("makes children ignorable on failure, so a dead child does not kill its parent", () => {
      const tree = flowJobFor(workflow, "test", { step: "parent", children: [{ step: "child" }] }, false);

      expect(tree.opts?.ignoreDependencyOnFailure).toBeUndefined();
      expect(tree.children?.[0].opts?.ignoreDependencyOnFailure).toBe(true);
    });

    it("lets a node override what the kernel defaulted", () => {
      const tree = flowJobFor(workflow, "test", { step: "parent", children: [{ step: "child", opts: { failParentOnFailure: true, ignoreDependencyOnFailure: false } }] }, false);

      expect(tree.children?.[0].opts?.failParentOnFailure).toBe(true);
      expect(tree.children?.[0].opts?.ignoreDependencyOnFailure).toBe(false);
    });
  });

  describe("ctx.enqueue", () => {
    it("wires the host's enqueue through to the step context", async () => {
      const calls: { workflow: string; node: EnqueueNode }[] = [];
      const workflow = defineWorkflow({
        name: "caller",
        description: "",
        entry: "hand-off",
        steps: [
          step("hand-off", async ({ enqueue }) => {
            await enqueue("recipe-enrichment", { step: "enrich", data: { recipeId: "abc123" } });
            return "handed off";
          }),
        ],
      });

      const host: WorkflowHost = {
        runId: "test",
        log: () => Promise.resolve(),
        progress: () => Promise.resolve(),
        children: () => Promise.resolve(EMPTY),
        flow: () => Promise.resolve(),
        enqueue: (targetWorkflow, node) => {
          calls.push({ workflow: targetWorkflow, node });
          return Promise.resolve();
        },
      };

      await expect(workflow.run({ payload: {}, host, redis: NO_REDIS })).resolves.toBe("handed off");
      expect(calls).toEqual([{ workflow: "recipe-enrichment", node: { step: "enrich", data: { recipeId: "abc123" } } }]);
    });

    describe("consoleHost", () => {
      it("logs the intent and does not run the target workflow", async () => {
        let ran = false;
        const workflow = defineWorkflow({ name: "caller", description: "", entry: "one", steps: [step("one", () => Promise.resolve())] });
        const host = consoleHost({
          workflow,
          runStep: () => {
            ran = true;
            return Promise.resolve();
          },
          concurrency: 1,
        });

        await expect(host.enqueue("recipe-enrichment", { step: "enrich" })).resolves.toBeUndefined();
        expect(ran).toBe(false);
      });
    });

    describe("jobHost", () => {
      // No real Redis, no real BullMQ `Job` — only what `enqueue` itself
      // touches is exercised, the same "pure wiring" boundary the rest of this
      // file keeps.
      const NO_JOB = {} as Job;
      const NO_FLOWS = {} as FlowProducer;

      it("throws on an unknown target workflow, the same way a bad entry step does", async () => {
        const workflow = defineWorkflow({ name: "caller", description: "", entry: "one", steps: [step("one", () => Promise.resolve())] });
        const host = jobHost(NO_JOB, workflow, NO_FLOWS, new Map(), () => undefined);

        await expect(host.enqueue("does-not-exist", {})).rejects.toThrow(/no workflow named "does-not-exist"/);
      });

      // Coverage for a target workflow's own entry step and job options winning
      // over the caller's used to live here, resolved through the module-level
      // WORKFLOWS registry with `demo` as the fixture. That registry is being
      // dissolved; the same behaviour is re-tested against the workflow
      // plugin's own registrations once the lookup moves there.
    });
  });
});
