import { loadConfig } from "#/config.ts";
import { log, setLogRole } from "#/log.ts";
import { closeRedis, getRedis } from "#/redis.ts";
import { consoleHost } from "#/workflows/hosts.ts";
import { SKIPPED } from "#/workflows/define.ts";
import { WORKFLOW_NAMES, findWorkflow } from "#/workflows/index.ts";

setLogRole("cli");

/**
 * Run one workflow to completion in this process, then exit.
 *
 *   pnpm --filter @buttery/pipeline run:once <workflow> [--flag] [--flag=value]
 *   pnpm --filter @buttery/pipeline sync:once --dry-run      # the same, for atproto-sync
 *
 * Same workflow, same steps, same `.env` as the queued path — only the host
 * differs (`hosts.ts`), so progress and step logs go to the terminal instead of
 * to a job. That equivalence is the point: iterating on a workflow through
 * Redis and a worker is a slow way to work, and a one-off backfill
 * (`SYNC_MAX_REPOS=25`, `SYNC_ONLY_DID=…`) should not need the dev stack up.
 *
 * Flags become the job payload, so anything the queue can send, a shell can:
 * `--dry-run` is `{"dryRun": true}` and `--label=hello` is `{"label": "hello"}`.
 *
 * Redis is still required, because `exclusive` workflows take their lock here
 * too — a sweep by hand must not run alongside a scheduled one just because a
 * person started it.
 */

interface Invocation {
  workflow: string;
  payload: Record<string, unknown>;
}

/** `--dry-run` → `dryRun: true`; `--max=3` → `max: "3"`. */
function toPayloadKey(flag: string): string {
  return flag.replace(/^--/, "").replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function parseArgv(argv: string[]): Invocation | undefined {
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const workflow = positional[0];
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

  try {
    const result = await workflow.run({
      payload: invocation.payload,
      host: consoleHost(workflow.name),
      redis,
    });
    // A skipped run is not a failure — the work is already being done elsewhere
    // — but it is also not the sweep the caller asked for, so say so plainly
    // rather than let an empty-looking success be mistaken for one.
    if (result === SKIPPED) log.warn("run skipped — another run holds this workflow's lock", { workflow: workflow.name });
    else log.info("run complete", { workflow: workflow.name, result });
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
