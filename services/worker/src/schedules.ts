import type { Duration } from "@temporalio/common";
import type { Client, ScheduleOptions } from "@temporalio/client";
import { ScheduleOverlapPolicy } from "@temporalio/client";
import { loadConfig } from "#/config.ts";
import { log } from "#/log.ts";
import { WORKFLOWS } from "#/workflows/index.ts";
import { workflowIdFor } from "#/workflows/id.ts";

/**
 * Reconciling the repo's schedules onto the cluster.
 *
 * A Temporal Schedule lives in the cluster and outlives every deployment, which
 * is the same property BullMQ's job schedulers had in Redis and the same trap:
 * a schedule nothing in the repo mentions any more keeps firing forever. So this
 * is a reconcile and not a register — a workflow whose `schedule()` returns
 * undefined has its schedule *deleted*, which is what makes emptying
 * `ATPROTO_SYNC_SCHEDULE` actually turn the sweep off.
 *
 * Where it runs is the interesting difference from the BullMQ build. There, the
 * reconcile had to happen in a process that (a) was always up and (b) there was
 * exactly one of, because two replicas racing would fight over the scheduler
 * keys — which is part of why that design needed a separate always-on service.
 * Here it is a *deploy step*: Railway's `preDeploy` runs it once per deploy, in
 * the built image, before any new container serves. Nothing has to stay up to
 * own it, and the worker fleet stays a fleet of identical, disposable replicas.
 */

/** Only schedules with this prefix are ours to delete. */
export const SCHEDULE_PREFIX = "buttery-";

export function scheduleIdFor(workflowName: string): string {
  return `${SCHEDULE_PREFIX}${workflowName}`;
}

/** What the repo says should exist, flattened for comparison. */
export interface DesiredSchedule {
  scheduleId: string;
  workflowName: string;
  cron: string;
  input: unknown;
  workflowId: string;
  executionTimeout: Duration | undefined;
}

export interface SchedulePlan {
  create: DesiredSchedule[];
  update: DesiredSchedule[];
  remove: string[];
}

/** Every workflow that declares a cron pattern right now. */
export function desiredSchedules(): DesiredSchedule[] {
  return WORKFLOWS.flatMap((workflow) => {
    const cron = workflow.schedule?.();
    if (!cron) return [];
    return [
      {
        scheduleId: scheduleIdFor(workflow.name),
        workflowName: workflow.name,
        cron,
        input: workflow.input({}),
        workflowId: workflowIdFor(workflow, "scheduled"),
        executionTimeout: workflow.executionTimeout,
      },
    ];
  });
}

/**
 * The diff, as a pure function so it can be tested without a cluster. `existing`
 * is every schedule id the cluster reports; ids without our prefix are somebody
 * else's and are left alone.
 */
export function planSchedules(desired: readonly DesiredSchedule[], existing: readonly string[]): SchedulePlan {
  const ours = existing.filter((id) => id.startsWith(SCHEDULE_PREFIX));
  const wanted = new Set(desired.map((schedule) => schedule.scheduleId));
  return {
    create: desired.filter((schedule) => !ours.includes(schedule.scheduleId)),
    update: desired.filter((schedule) => ours.includes(schedule.scheduleId)),
    remove: ours.filter((id) => !wanted.has(id)),
  };
}

function optionsFor(schedule: DesiredSchedule, taskQueue: string): ScheduleOptions {
  return {
    scheduleId: schedule.scheduleId,
    // Cron patterns are UTC unless a timezone is named, and naming one here
    // would make "hourly" mean something different in March and November.
    spec: { cronExpressions: [schedule.cron] },
    policies: {
      // The interlock a queue needs a distributed lock for. SKIP means a firing
      // that lands while the previous run is still going is dropped, not queued:
      // the work is already being done, and a sweep that runs long should cost
      // one skipped hour rather than a pile-up that never drains.
      overlap: ScheduleOverlapPolicy.SKIP,
      // If the cluster itself was down over several firings, run one — not the
      // backlog. Sweeps are reconciliations; the newest one subsumes the rest.
      catchupWindow: "1 minute",
    },
    action: {
      type: "startWorkflow",
      workflowType: schedule.workflowName,
      taskQueue,
      args: [schedule.input],
      workflowId: schedule.workflowId,
      workflowExecutionTimeout: schedule.executionTimeout,
    },
  };
}

export interface ReconcileSummary {
  created: string[];
  updated: string[];
  removed: string[];
}

/** Apply `planSchedules` against a live cluster. Idempotent; safe to run on every deploy. */
export async function reconcileSchedules(client: Client): Promise<ReconcileSummary> {
  const { temporal } = loadConfig();

  const existing: string[] = [];
  for await (const schedule of client.schedule.list()) {
    existing.push(schedule.scheduleId);
  }

  const plan = planSchedules(desiredSchedules(), existing);

  for (const schedule of plan.create) {
    await client.schedule.create(optionsFor(schedule, temporal.taskQueue));
    log.info("schedule created", { scheduleId: schedule.scheduleId, cron: schedule.cron });
  }

  for (const schedule of plan.update) {
    // `update` takes the current description and returns the new one, so the
    // cluster can reject a write that raced another. Everything this service
    // owns is overwritten; anything a person paused stays paused, because
    // `state` is carried through untouched.
    const options = optionsFor(schedule, temporal.taskQueue);
    await client.schedule.getHandle(schedule.scheduleId).update((previous) => ({
      ...previous,
      spec: options.spec,
      policies: { ...previous.policies, ...options.policies },
      action: options.action,
    }));
    log.info("schedule updated", { scheduleId: schedule.scheduleId, cron: schedule.cron });
  }

  for (const scheduleId of plan.remove) {
    await client.schedule.getHandle(scheduleId).delete();
    log.warn("schedule removed — no workflow in this build declares it", { scheduleId });
  }

  return {
    created: plan.create.map((schedule) => schedule.scheduleId),
    updated: plan.update.map((schedule) => schedule.scheduleId),
    removed: plan.remove,
  };
}
