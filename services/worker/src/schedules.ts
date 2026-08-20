import type { Client, ScheduleOptions } from "@temporalio/client";
import { ScheduleOverlapPolicy } from "@temporalio/client";
import { loadConfig } from "#/config.ts";
import { log } from "#/log.ts";
import { atprotoSync } from "#/workflows.ts";

/**
 * The schedules this build wants, and the reconcile that makes the cluster match.
 *
 * A Temporal Schedule lives in the cluster and outlives every deployment, so this
 * is a reconcile rather than a register: a schedule the repo no longer declares
 * is *deleted*. That is what makes emptying `ATPROTO_SYNC_SCHEDULE` actually turn
 * the sweep off instead of orphaning one that keeps firing from a config nothing
 * mentions any more.
 *
 * Deleting on that basis is only safe because the namespace is ours — everything
 * in `buttery` is declared here, so anything else found in it is stale by
 * definition. That is most of the argument for not sharing `default`.
 *
 * Where it runs: Railway's `preDeploy`, once per deploy, in the built image,
 * before any new container serves. Nothing has to stay up to own it.
 */

/** Passing the workflow function rather than its name is what type-checks `args`. */
export function desiredSchedules(taskQueue: string): ScheduleOptions[] {
  // Cron patterns are UTC unless a timezone is named, and naming one would make
  // "hourly" mean something different in March and November.
  const cron = process.env.ATPROTO_SYNC_SCHEDULE;
  if (!cron) return [];

  return [
    {
      scheduleId: "atproto-sync",
      spec: { cronExpressions: [cron] },
      policies: {
        // A firing that lands while the previous run is still going is dropped,
        // not queued: the work is already being done, and a sweep that runs long
        // should cost one skipped hour rather than a pile-up that never drains.
        overlap: ScheduleOverlapPolicy.SKIP,
        // If the cluster itself was down across several firings, run one — not
        // the backlog. Sweeps reconcile; the newest one subsumes the rest.
        catchupWindow: "1 minute",
      },
      action: {
        type: "startWorkflow",
        workflowType: atprotoSync,
        taskQueue,
        // A scheduled sweep takes the defaults: everything about it is the
        // deployment's environment.
        args: [{}],
        workflowId: "atproto-sync",
        // A backstop, not a target: a full sweep runs in minutes. What this
        // catches is a run that has wedged, which would otherwise sit forever.
        workflowExecutionTimeout: "2 hours",
      },
    },
  ];
}

export interface SchedulePlan {
  create: ScheduleOptions[];
  update: ScheduleOptions[];
  remove: string[];
}

/** The diff, pure so it can be tested without a cluster. */
export function planSchedules(desired: readonly ScheduleOptions[], existing: readonly string[]): SchedulePlan {
  const wanted = new Set(desired.map((schedule) => schedule.scheduleId));
  return {
    create: desired.filter((schedule) => !existing.includes(schedule.scheduleId)),
    update: desired.filter((schedule) => existing.includes(schedule.scheduleId)),
    remove: existing.filter((scheduleId) => !wanted.has(scheduleId)),
  };
}

export interface ReconcileSummary {
  created: string[];
  updated: string[];
  removed: string[];
}

/** Apply the plan against a live cluster. Idempotent; safe to run on every deploy. */
export async function reconcileSchedules(client: Client): Promise<ReconcileSummary> {
  const { taskQueue } = loadConfig();

  const existing: string[] = [];
  for await (const schedule of client.schedule.list()) {
    existing.push(schedule.scheduleId);
  }

  const plan = planSchedules(desiredSchedules(taskQueue), existing);

  for (const schedule of plan.create) {
    await client.schedule.create(schedule);
    log.info("schedule created", { scheduleId: schedule.scheduleId });
  }

  for (const schedule of plan.update) {
    // `update` takes the current description and returns the new one, so the
    // cluster can reject a write that raced another. Everything declared here is
    // overwritten; anything a person paused stays paused, because `state` is
    // carried through untouched.
    await client.schedule.getHandle(schedule.scheduleId).update((previous) => ({
      ...previous,
      spec: schedule.spec ?? previous.spec,
      policies: { ...previous.policies, ...schedule.policies },
      action: schedule.action,
    }));
    log.info("schedule updated", { scheduleId: schedule.scheduleId });
  }

  for (const scheduleId of plan.remove) {
    await client.schedule.getHandle(scheduleId).delete();
    log.warn("schedule removed — nothing in this build declares it", { scheduleId });
  }

  return {
    created: plan.create.map((schedule) => schedule.scheduleId),
    updated: plan.update.map((schedule) => schedule.scheduleId),
    removed: plan.remove,
  };
}
