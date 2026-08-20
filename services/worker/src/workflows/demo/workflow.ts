import { log, proxyActivities, sleep } from "@temporalio/workflow";
import type * as activities from "#/workflows/demo/activities.ts";
import type { DemoInput, DemoResult } from "#/workflows/demo/types.ts";

/**
 * The reference workflow: what this service does, with none of the domain.
 *
 * Run it and watch it in the UI —
 *
 *   pnpm --filter @buttery/worker run:once demo --label=hello
 *   pnpm --filter @buttery/worker run:once demo --fail
 *
 * — because three things it demonstrates are the whole argument for Temporal
 * over a job queue:
 *
 *  1. **The timer is durable.** `sleep` below occupies no worker and survives
 *     every restart. Kill the worker while it is sleeping and the run resumes
 *     when a worker comes back, with the remaining time honoured.
 *  2. **A retry does not restart the run.** With `--fail`, the last step fails
 *     twice and is retried twice; the two steps before it do not run again,
 *     because their results are already in the history. A BullMQ job would have
 *     re-run the whole thing, or needed a hand-maintained step cursor to avoid
 *     it.
 *  3. **The failure is legible.** Every attempt, its error and its backoff show
 *     up on the timeline without anything here logging them.
 */
const { demoStep } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumAttempts: 3 },
});

export async function demo(input: DemoInput = {}): Promise<DemoResult> {
  const label = input.label ?? "demo";
  const slice = Math.max(Math.floor((input.durationMs ?? 3_000) / 3), 100);

  const steps = [await demoStep({ name: "warm-up", durationMs: slice })];
  log.info("warmed up, sleeping", { label, slice });

  // Durable: this is a timer held by the Temporal service, not a worker.
  await sleep(slice);

  steps.push(await demoStep({ name: "work", durationMs: slice }));
  steps.push(await demoStep({ name: "finish", durationMs: 0, failTimes: input.fail ? 2 : 0 }));

  return { label, steps };
}
