import { atprotoSync } from "#/workflows/atproto-sync/workflow.ts";
import { demo } from "#/workflows/demo/workflow.ts";

/**
 * The workflow bundle's entrypoint: every workflow function, under the name the
 * client starts it by.
 *
 * The worker hands this file to a bundler (`workflowsPath` in `worker.ts`) and
 * runs the result inside a deterministic isolate — no `process`, no clock, no
 * network. So this file, and its whole import graph, has to stay sandbox-safe;
 * see the sandbox rule in `define.ts`. It is a barrel of nothing but
 * `workflow.ts` re-exports for exactly that reason: one import of `lib/` here
 * would pull `pg` into the isolate. `bundle.test.ts` builds it the way the
 * worker does, which makes that a red test rather than a red deploy.
 *
 * **The export name is the workflow type.** A client that starts
 * `"atproto-sync"` gets a worker looking up exactly that key in this module's
 * namespace, and a mismatch is not a type error — it is a workflow that starts,
 * fails its first task with "no such function is exported by the workflow
 * bundle", and retries that forever. Which is why the names below are quoted:
 * `export { x as "some-string" }` is ES2022's arbitrary module namespace names,
 * and it lets the workflow type stay the same kebab-case identifier the CLI, the
 * schedule id and the registry all use, rather than making every one of those
 * carry a second, camel-cased name for the sake of a function declaration.
 * `registry.test.ts` checks the two lists agree.
 */
export { atprotoSync as "atproto-sync", demo };
