import { log, proxyActivities, sleep } from "@temporalio/workflow";
import type { DemoActivities } from "#/workflows/demo/activities.ts";
import type { DemoInput, DemoResult } from "#/workflows/demo/types.ts";

/**
 * The reference workflow: what this service does, with none of the domain.
 *
 *   temporal workflow execute --type demo --task-queue buttery \
 *     --workflow-id demo-1 --input '{"label":"hello"}'
 *   temporal workflow execute --type demo --task-queue buttery \
 *     --workflow-id demo-2 --input '{"fail":true}'
 *
 * Three things it demonstrates, all of which the Temporal UI shows without this
 * repo writing a line of dashboard:
 *
 *  1. **The timer is durable.** `sleep` below occupies no worker and survives
 *     every restart. Kill the worker while it is sleeping and the run resumes
 *     when one comes back, with the remaining time honoured.
 *  2. **A retry does not restart the run.** With `{"fail":true}` the last step
 *     fails twice and is retried twice; the two steps before it do not run
 *     again, because their results are already in the history.
 *  3. **The failure is legible.** Every attempt, its error and its backoff are
 *     on the timeline without anything here logging them.
 */
const { demoStep } = proxyActivities<DemoActivities>({
  startToCloseTimeout: "1 minute",
  retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumAttempts: 3 },
});

export async function demo(input: DemoInput = {}): Promise<DemoResult> {
  const label = input.label ?? "demo";
  const slice = Math.max(Math.floor((input.durationMs ?? 3_000) / 3), 100);

  const steps = [await demoStep({ name: "warm-up", durationMs: slice })];
  log.info("warmed up, sleeping", { label, slice });

  // Durable: this is a timer held by the Temporal service, not by a worker.
  await sleep(slice);

  steps.push(await demoStep({ name: "work", durationMs: slice }));
  steps.push(await demoStep({ name: "finish", durationMs: 0, failTimes: input.fail ? 2 : 0 }));

  return { label, steps };
}
