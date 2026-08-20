import { describe, expect, it } from "vitest";
import { type DesiredSchedule, planSchedules, SCHEDULE_PREFIX, scheduleIdFor } from "#/schedules.ts";

function desired(workflowName: string, cron = "0 * * * *"): DesiredSchedule {
  return {
    scheduleId: scheduleIdFor(workflowName),
    workflowName,
    cron,
    input: {},
    workflowId: workflowName,
    executionTimeout: undefined,
  };
}

describe("planSchedules", () => {
  it("creates a schedule the cluster does not have", () => {
    expect(planSchedules([desired("atproto-sync")], [])).toEqual({
      create: [desired("atproto-sync")],
      update: [],
      remove: [],
    });
  });

  it("updates one it already has, rather than recreating it", () => {
    const plan = planSchedules([desired("atproto-sync", "*/15 * * * *")], [scheduleIdFor("atproto-sync")]);
    expect(plan.create).toEqual([]);
    expect(plan.update.map((s) => s.cron)).toEqual(["*/15 * * * *"]);
    expect(plan.remove).toEqual([]);
  });

  it("removes a schedule no workflow declares any more", () => {
    // The case that matters: emptying ATPROTO_SYNC_SCHEDULE has to turn the
    // sweep OFF, not orphan a schedule that keeps firing from a config nothing
    // in the repo mentions.
    expect(planSchedules([], [scheduleIdFor("atproto-sync")]).remove).toEqual([scheduleIdFor("atproto-sync")]);
  });

  it("leaves schedules it does not own alone", () => {
    const plan = planSchedules([], ["someone-elses-schedule", `${SCHEDULE_PREFIX}gone`]);
    expect(plan.remove).toEqual([`${SCHEDULE_PREFIX}gone`]);
  });
});
