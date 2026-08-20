import { activityInfo, sleep } from "@temporalio/activity";

/**
 * One pretend unit of work.
 *
 * `activityInfo().attempt` is the interesting part: an activity knows which
 * attempt it is on, which is how `failTimes` fails a fixed number of times and
 * then succeeds. Real activities use the same fact to decide when to stop being
 * optimistic — skip a cache on a retry, widen a timeout, log louder.
 *
 * `sleep` here is `@temporalio/activity`'s, not `@temporalio/workflow`'s. This
 * one is a plain cancellation-aware timer burning a worker slot; the workflow's
 * is durable, costs no worker at all, and is what you want for anything longer
 * than seconds.
 */
export async function demoStep(input: { name: string; durationMs: number; failTimes?: number }): Promise<string> {
  const { attempt } = activityInfo();
  if (input.failTimes && attempt <= input.failTimes) {
    throw new Error(`step "${input.name}" failed on attempt ${attempt} (fail: true)`);
  }
  await sleep(input.durationMs);
  return `${input.name} ok on attempt ${attempt}`;
}
