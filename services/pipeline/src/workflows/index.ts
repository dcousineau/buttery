import type { Workflow } from "#/lib/bullmq/kernel.ts";

/**
 * Every workflow still registered through the old `defineWorkflow` path
 * (`fastify.workflow(spec)` is the other one — see `plugins/workflow.ts`).
 * `server.ts`, `worker.ts`, `schedules.ts` and `queues.ts` all read this list
 * and nothing else in the service is queue-aware through it.
 *
 * Empty now: `atproto-sync` and `recipe-enrichment`, the two workflows that
 * used to live here, have both migrated to `fastify.workflow(spec)` and
 * register themselves from inside their own plugin body instead. This file
 * is not deleted yet — `findWorkflow`/`WORKFLOW_NAMES` still have other
 * importers — but there is nothing left to add an entry for.
 */
export const WORKFLOWS: readonly Workflow[] = [];

export const WORKFLOW_NAMES: readonly string[] = WORKFLOWS.map((workflow) => workflow.name);

export function findWorkflow(name: string): Workflow | undefined {
  return WORKFLOWS.find((workflow) => workflow.name === name);
}
