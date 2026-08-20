import { defineWorkflow } from "#/workflows/define.ts";
import type { DemoInput } from "#/workflows/demo/types.ts";

/** Registration for the reference workflow. See `workflow.ts` for what it shows. */
export const demo = defineWorkflow({
  name: "demo",
  description: "Reference workflow: durable timer, activity retries, resumable history",

  input: (flags): DemoInput => ({
    label: typeof flags.label === "string" ? flags.label : undefined,
    durationMs: typeof flags["duration-ms"] === "string" ? Number(flags["duration-ms"]) : undefined,
    fail: flags.fail === true,
  }),

  // No schedule and not a singleton: start as many as you like, whenever.
  executionTimeout: "10 minutes",
});
