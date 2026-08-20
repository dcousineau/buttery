/**
 * The workflow bundle: every workflow this build can run, under the name it is
 * started by.
 *
 * The worker points its bundler at this file (`workflowsPath` in `worker.ts`)
 * and runs the result inside a deterministic isolate — no `process`, no clock,
 * no network — so this file and its whole import graph must stay sandbox-safe.
 * It re-exports `workflow.ts` files and nothing else for that reason: a single
 * import of an activity implementation here would pull `pg` into the isolate.
 * `workflows.test.ts` builds it the way the worker does, which makes that a red
 * test rather than a red deploy.
 *
 * The exported name is the workflow type — `temporal workflow start --type
 * atprotoSync`, and what `client.workflow.start(atprotoSync, …)` resolves to.
 */
export { atprotoSync } from "#/workflows/atproto-sync/workflow.ts";
export { demo } from "#/workflows/demo/workflow.ts";
