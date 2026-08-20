import type { Client } from "@temporalio/client";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { withClient } from "#/client.ts";
import { loadConfig } from "#/config.ts";
import { log, setLogRole } from "#/log.ts";
import { parseFlags, type WorkflowRegistration } from "#/workflows/define.ts";
import { workflowIdFor } from "#/workflows/id.ts";
import { findWorkflow, WORKFLOWS } from "#/workflows/index.ts";

/**
 * Start one workflow from a shell and wait for its result.
 *
 *   pnpm --filter @buttery/worker run:once demo --label=hello --fail
 *   pnpm --filter @buttery/worker sync:once --dry-run
 *
 * Note what this does NOT do: run the work. It starts a workflow and waits; a
 * worker executes it. That is a real difference from the BullMQ build's
 * `run:once`, which did the work in the shell and needed nothing else running —
 * here the local stack (`pnpm dev`) has to be up. What it buys is that a run
 * started by hand is the same execution, on the same fleet, with the same
 * history and the same UI page as a scheduled one. There is no second code path
 * that can quietly drift.
 */

setLogRole("cli");

function usage(): never {
  const rows = WORKFLOWS.map((workflow) => `  ${workflow.name.padEnd(16)} ${workflow.description}`).join("\n");
  process.stderr.write(`usage: run:once <workflow> [--flags]\n\nworkflows:\n${rows}\n`);
  process.exit(1);
}

/**
 * A singleton must not run twice, and Temporal's guarantee — one running
 * execution per workflow id — only covers the runs that share an id. Scheduled
 * runs do not: the cluster appends the firing time to the id it starts them
 * under, so overlap between two *scheduled* runs is prevented by the schedule's
 * SKIP policy instead (see `schedules.ts`).
 *
 * That leaves this case — someone typing `sync:once` while a scheduled sweep is
 * already running — which a visibility query closes. It is eventually
 * consistent, so it is a courtesy rather than a lock: two shells racing each
 * other by milliseconds can both get past it, and the fixed workflow id below is
 * what actually stops them.
 */
async function alreadyRunning(client: Client, workflow: WorkflowRegistration): Promise<boolean> {
  const query = `WorkflowType = '${workflow.name}' AND ExecutionStatus = 'Running'`;
  for await (const _execution of client.workflow.list({ query, pageSize: 1 })) {
    return true;
  }
  return false;
}

const [name, ...rest] = process.argv.slice(2);
if (!name) usage();

const workflow = findWorkflow(name);
if (!workflow) {
  process.stderr.write(`unknown workflow "${name}"\n\n`);
  usage();
}

const flags = parseFlags(rest);
const input = workflow.input(flags);
const config = loadConfig();

await withClient(async (client) => {
  if (workflow.singleton && (await alreadyRunning(client, workflow))) {
    log.warn("skipped — a run of this workflow is already in flight", { workflow: workflow.name });
    return;
  }

  try {
    const handle = await client.workflow.start(workflow.name, {
      taskQueue: config.temporal.taskQueue,
      workflowId: workflowIdFor(workflow, String(Date.now())),
      // The other half of the singleton interlock: FAIL rather than start a
      // second execution under an id that already has a running one.
      workflowIdConflictPolicy: "FAIL",
      workflowExecutionTimeout: workflow.executionTimeout,
      args: [input],
    });
    log.info("workflow started", { workflow: workflow.name, workflowId: handle.workflowId, runId: handle.firstExecutionRunId, input });

    const result: unknown = await handle.result();
    log.info("workflow complete", { workflow: workflow.name, workflowId: handle.workflowId, result });
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      log.warn("skipped — a run of this workflow is already in flight", { workflow: workflow.name });
      return;
    }
    log.error("workflow failed", { workflow: workflow.name, err: String(err) });
    process.exitCode = 1;
  }
});
