import { atprotoSync } from "#/workflows/atproto-sync/index.ts";
import { demo } from "#/workflows/demo/index.ts";
import type { Workflow } from "#/workflows/define.ts";

/**
 * Every workflow this service knows about. The one list; `server.ts`,
 * `worker.ts`, `schedules.ts` and `queues.ts` all read it and nothing else in
 * the service is queue-aware.
 *
 * Adding a workflow is a folder under `workflows/` and one entry here. See
 * `define.ts` for what a workflow is, and `atproto-sync/` for the layout a
 * workflow with more than a file's worth of code should follow.
 */
export const WORKFLOWS: readonly Workflow[] = [atprotoSync, demo];

export const WORKFLOW_NAMES: readonly string[] = WORKFLOWS.map((workflow) => workflow.name);

export function findWorkflow(name: string): Workflow | undefined {
  return WORKFLOWS.find((workflow) => workflow.name === name);
}
