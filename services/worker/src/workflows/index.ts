import { atprotoSync } from "#/workflows/atproto-sync/index.ts";
import { demo } from "#/workflows/demo/index.ts";
import type { WorkflowRegistration } from "#/workflows/define.ts";

/**
 * Every workflow this service knows about. The one list: `worker.ts`,
 * `schedules-sync.ts` and `run-once.ts` all read it, and nothing else in the
 * service names a workflow.
 *
 * Adding a workflow is a folder under `workflows/`, one entry here, and one line
 * in each of `bundle.ts` and `activities.ts` — the two barrels that exist because
 * the worker loads workflow code and activity code by two different mechanisms.
 * `registry.test.ts` checks the three lists agree.
 */
export const WORKFLOWS: readonly WorkflowRegistration[] = [atprotoSync, demo];

export const WORKFLOW_NAMES: readonly string[] = WORKFLOWS.map((workflow) => workflow.name);

export function findWorkflow(name: string): WorkflowRegistration | undefined {
  return WORKFLOWS.find((workflow) => workflow.name === name);
}

/**
 * Release whatever the workflows' activities hold open — pg pools, mostly.
 * Called once, after the worker has drained; an open pool keeps the event loop
 * alive and a container that will not exit is a deploy that hangs.
 */
export async function closeWorkflowResources(): Promise<void> {
  const closers = WORKFLOWS.flatMap((workflow) => (workflow.close ? [workflow.close()] : []));
  await Promise.all(closers);
}
