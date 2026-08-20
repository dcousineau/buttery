import type { WorkflowRegistration } from "#/workflows/define.ts";

/**
 * The workflow id a run gets — which is also this service's mutual-exclusion
 * primitive.
 *
 * Temporal refuses to start a workflow whose id already has a *running*
 * execution. So a `singleton` workflow is simply one that always uses the same
 * id: the scheduled sweep, a sweep started from the UI and `sync:once` all aim
 * at `atproto-sync`, and the second one to arrive is rejected rather than run.
 * The BullMQ build spent a Redis key, a TTL and a heartbeat on this.
 *
 * Everything else gets a unique id. `discriminator` is the caller's — a
 * timestamp from the CLI, "scheduled" from the schedule — and never a random
 * value: ids are how you find a run again.
 */
export function workflowIdFor(workflow: WorkflowRegistration, discriminator: string): string {
  return workflow.singleton ? workflow.name : `${workflow.name}-${discriminator}`;
}
