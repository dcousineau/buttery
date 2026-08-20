import { withClient } from "#/client.ts";
import { log, setLogRole } from "#/log.ts";
import { reconcileSchedules } from "#/schedules.ts";

/**
 * Reconcile this build's schedules onto the cluster, then exit.
 *
 * Runs as Railway's `preDeploy` for the worker service and as a one-shot in the
 * local process-compose stack. Idempotent by construction, so re-running it is
 * free and a failed deploy leaves nothing half-applied.
 *
 * See `schedules.ts` for why removal is part of the job.
 */

setLogRole("schedules");

try {
  const summary = await withClient(reconcileSchedules);
  log.info("schedules reconciled", { ...summary });
} catch (err) {
  // A non-zero exit aborts the deploy and keeps the old containers serving,
  // which is the right call: a build whose schedules did not land is a build
  // whose sweeps might not run.
  log.error("schedule reconciliation failed", { err: String(err) });
  process.exitCode = 1;
}
