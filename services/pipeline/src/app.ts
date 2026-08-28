import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import autoload from "@fastify/autoload";
import type { PipelineRole } from "#/plugins/workflow.ts";
import { setLogRole } from "#/lib/log.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Assembles the Fastify instance every entrypoint — `server.ts`, `worker.ts`,
 * `run-once.ts` — shares: configured, but not yet listening (that's each
 * entrypoint's own job, since only `server.ts` actually calls `.listen()`).
 *
 * Two `@fastify/autoload` calls, in this order, not one recursive autoload
 * over `src/`:
 *
 * 1. `src/plugins/` — `role` is passed through as every plugin's `opts`,
 *    since `plugins/workflow.ts` branches its `onReady` on it (build a
 *    `Worker` for "worker", reconcile schedules for "server", do neither for
 *    "cli"). Cross-file ordering *within* this call (`env` before
 *    `redis`/`db`, both before `workflow`, ...) comes from each plugin's own
 *    `fp(fn, { dependencies })` — autoload's `registerPlugin` resolves those
 *    by name, but only among plugins registered through the SAME autoload
 *    call's own plugin tree.
 * 2. `src/workflows/` — the workflow plugins, each calling
 *    `fastify.workflow({...})` from its own body.
 *
 * That's also why (2) has to happen strictly after (1) has fully booted, and
 * why each workflow plugin's `dependencies: ["workflow", ...]` (declared in
 * its own file) is not enough on its own: a dependency name only resolves
 * within one autoload call's plugin tree, and `workflow` lives in the OTHER
 * one. What actually guarantees `fastify.workflow` exists before a workflow
 * plugin body runs is avvio not starting to boot the second `register()`
 * call until the first has fully readied. The `dependencies` arrays still
 * earn their keep — they're what stops someone reordering *within* a call
 * (say, splitting `db`/`redis`/`workflow` differently) from silently
 * breaking this again.
 */
export async function buildApp(role: PipelineRole): Promise<FastifyInstance> {
  // Before anything else logs: `lib/log.ts`'s `role` field (read by its two
  // remaining call sites) is set here, once, the same way `setLogRole` used to
  // be called at the top of each entrypoint.
  setLogRole(role);

  // Matches `lib/log.ts`'s line shape exactly — both feed one log stream and
  // there is no reason for them to disagree. `logger: false` (what
  // `server.ts` uses today) would make every `fastify.log.*` call the
  // converted workflows already make vanish with no error, which is worse
  // than a shape mismatch.
  const base: Record<string, string> = { svc: "pipeline", role };
  if (process.env.RAILWAY_REPLICA_ID) {
    base.replica = process.env.RAILWAY_REPLICA_ID;
  }

  const app = Fastify({
    // Railway terminates TLS in front of the container.
    trustProxy: true,
    logger: {
      level: "info",
      // Replaces pino's default `{pid, hostname}` base entirely (rather than
      // merging with it) — that's what drops `pid`/`hostname` from the line.
      base,
      // `lib/log.ts`'s lines carry no timestamp field; pino's does by
      // default. Disabled so both sources agree on the same shape.
      timestamp: false,
      formatters: {
        // pino's default `level` is a number; `lib/log.ts`'s is the string name.
        level: (label) => ({ level: label }),
      },
    },
  });

  await app.register(autoload, {
    dir: path.join(__dirname, "plugins"),
    options: { role },
  });

  await app.register(autoload, {
    dir: path.join(__dirname, "workflows"),
    // `src/workflows/` recurses (autoload's default): without this filter,
    // every module under a workflow's `lib/` directory and every
    // `*.test.ts` file that isn't shadowed by a sibling `index.ts` gets
    // treated as its own standalone plugin candidate the moment autoload
    // walks into a directory with no `index.ts` of its own (e.g. `lib/`).
    // Restricting to exactly one path segment plus `index.ts` keeps:
    //   - `workflows/index.ts` itself out (zero path segments — that file
    //     is the old `defineWorkflow` registry, not a Fastify plugin);
    //   - `steps.ts`, `types.ts`, `plan.ts` and anything under `lib/` out
    //     (wrong filename, or too many path segments);
    //   - every `*.test.ts` out, including
    //     `recipe-enrichment/index.llm.db.test.ts` (filename isn't exactly
    //     `index.ts`).
    // Verified empirically — see the app.test.ts registry assertion.
    matchFilter: /^\/[^/]+\/index\.ts$/,
  });

  return app;
}
