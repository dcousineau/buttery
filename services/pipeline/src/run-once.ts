import { loadConfig } from "#/config.ts";
import { log, setLogRole } from "#/log.ts";
import { closeRedis, getRedis } from "#/redis.ts";
import type { ChildResults, Workflow } from "#/lib/bullmq/kernel.ts";
import { consoleHost } from "#/lib/bullmq/hosts.ts";
import { WORKFLOW_NAMES, findWorkflow } from "#/workflows/index.ts";

setLogRole("cli");

/**
 * Run one workflow to completion in this process, then exit.
 *
 *   pnpm --filter @buttery/pipeline run:once <workflow> [--flag] [--flag=value]
 *   pnpm --filter @buttery/pipeline sync:once --dry-run      # the same, for atproto-sync
 *
 * Same workflow, same steps, same graph, same `.env` as the queued path — only
 * the host differs (`hosts.ts`), so the fan-out runs here instead of on the
 * fleet, and log lines go to the terminal instead of to a job. That equivalence
 * is the point: iterating on a workflow through Redis and a worker is a slow way
 * to work, and a one-off backfill (`SYNC_MAX_REPOS=25`, `SYNC_ONLY_DID=…`)
 * should not need the dev stack up.
 *
 * Flags become the entry job's payload, so anything the queue can send, a shell
 * can: `--dry-run` is `{"dryRun": true}` and `--label=hello` is
 * `{"label": "hello"}`.
 *
 * Redis is still required: steps take locks on it, and a sweep by hand must not
 * run alongside a scheduled one just because a person started it.
 */

interface Invocation {
  workflow: string;
  payload: Record<string, unknown>;
}

/** `--dry-run` → `dryRun: true`; `--max-repos=3` → `maxRepos: "3"`. */
function toPayloadKey(flag: string): string {
  return flag.replace(/^--/, "").replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function parseArgv(argv: string[]): Invocation | undefined {
  const workflow = argv.filter((arg) => !arg.startsWith("--"))[0];
  if (!workflow) return undefined;

  const payload: Record<string, unknown> = {};
  for (const arg of argv.filter((a) => a.startsWith("--"))) {
    const eq = arg.indexOf("=");
    if (eq === -1) payload[toPayloadKey(arg)] = true;
    else payload[toPayloadKey(arg.slice(0, eq))] = arg.slice(eq + 1);
  }
  return { workflow, payload };
}

async function main(): Promise<void> {
  const invocation = parseArgv(process.argv.slice(2));
  const workflow = invocation ? findWorkflow(invocation.workflow) : undefined;
  if (!invocation || !workflow) {
    log.error("usage: run-once <workflow> [--flag] [--flag=value]", { workflows: WORKFLOW_NAMES });
    process.exitCode = 2;
    return;
  }

  const config = loadConfig();
  const redis = getRedis(config.redisUrl);

  // The last step to finish is the graph's outcome — the root of the flow the
  // entry step submitted, which finishes after everything it waited on. The
  // entry step's own return value is just what it reported before fanning out.
  let outcome: { step: string; result: unknown } | undefined;

  // One recursive definition covers the whole graph: a step runs with a host
  // that knows how to run the steps it fans out to, which is this same function.
  const runStep = async (target: Workflow, step: string, payload: unknown, children: ChildResults): Promise<unknown> => {
    const result = await target.run({
      step,
      payload,
      host: consoleHost({ workflow: target, runStep: (s, p, c) => runStep(target, s, p, c), concurrency: config.worker.concurrency }, children),
      redis,
    });
    // The entry step returns before the graph it submitted has finished — the
    // children and the step waiting on them all completed inside that call. So
    // the entry's own value only counts when nothing deeper produced one.
    if (step !== target.entry || outcome === undefined) outcome = { step, result };
    return result;
  };

  try {
    await runStep(workflow, workflow.entry, invocation.payload, { values: [], failures: [] });
    log.info("run complete", { workflow: workflow.name, step: outcome?.step, result: outcome?.result });
  } catch (err) {
    log.error("run failed", { workflow: workflow.name, err: String(err) });
    process.exitCode = 1;
  } finally {
    // Both MUST happen or the process never exits: a pg pool and a Redis socket
    // each keep the event loop alive on their own.
    await workflow.close?.();
    await closeRedis();
  }
}

await main();
