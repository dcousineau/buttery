import type { ScheduleOptions } from "@temporalio/client";
import { describe, expect, it } from "vitest";
import { desiredSchedules, planSchedules } from "#/schedules.ts";

function schedule(scheduleId: string): ScheduleOptions {
  return {
    scheduleId,
    spec: { cronExpressions: ["0 * * * *"] },
    action: { type: "startWorkflow", workflowType: "atprotoSync", taskQueue: "buttery", args: [{}] },
  };
}

describe("desiredSchedules", () => {
  it("declares nothing when the schedule variable is unset", () => {
    // The local default. A laptop should not quietly sweep the live atmosphere
    // in the background — and an unset variable has to mean "off", not "keep
    // whatever the cluster already has".
    delete process.env.ATPROTO_SYNC_SCHEDULE;
    expect(desiredSchedules("buttery")).toEqual([]);
  });

  it("declares the sweep on the cron it is given", () => {
    process.env.ATPROTO_SYNC_SCHEDULE = "*/15 * * * *";
    const [sweep, ...rest] = desiredSchedules("buttery");
    delete process.env.ATPROTO_SYNC_SCHEDULE;

    expect(rest).toEqual([]);
    expect(sweep.scheduleId).toBe("atproto-sync");
    expect(sweep.spec).toMatchObject({ cronExpressions: ["*/15 * * * *"] });
    expect(sweep.action).toMatchObject({ taskQueue: "buttery", workflowId: "atproto-sync" });
  });
});

describe("planSchedules", () => {
  it("creates a schedule the cluster does not have", () => {
    const plan = planSchedules([schedule("atproto-sync")], []);
    expect(plan.create.map((s) => s.scheduleId)).toEqual(["atproto-sync"]);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("updates one it already has, rather than recreating it", () => {
    const plan = planSchedules([schedule("atproto-sync")], ["atproto-sync"]);
    expect(plan.create).toEqual([]);
    expect(plan.update.map((s) => s.scheduleId)).toEqual(["atproto-sync"]);
    expect(plan.remove).toEqual([]);
  });

  it("removes anything in the namespace this build does not declare", () => {
    // The case that matters twice over: emptying ATPROTO_SYNC_SCHEDULE turns the
    // sweep OFF, and a schedule left behind by an older build does not outlive it.
    expect(planSchedules([], ["atproto-sync", "something-older"]).remove).toEqual(["atproto-sync", "something-older"]);
  });
});
