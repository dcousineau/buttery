import type { Queue } from "bullmq";
import { describe, expect, it } from "vitest";
import { readBacklog } from "#/lib/bullmq/backlog.ts";

/** The two members `readBacklog` touches, which is all a queue needs to be here. */
function stubQueue(name: string, counts: Record<string, number>): Queue {
  return { name, getJobCounts: () => Promise.resolve(counts) } as unknown as Queue;
}

describe("readBacklog", () => {
  it("counts waiting + active as pending, and nothing else", async () => {
    const snapshot = await readBacklog([stubQueue("a", { waiting: 3, active: 2, delayed: 7, failed: 11, completed: 99 })]);

    expect(snapshot.queues[0]).toEqual({
      name: "a",
      waiting: 3,
      active: 2,
      delayed: 7,
      failed: 11,
      completed: 99,
      pending: 5,
    });
    expect(snapshot.pending).toBe(5);
  });

  it("excludes delayed jobs — work scheduled for later is not work the fleet can do now", async () => {
    const snapshot = await readBacklog([stubQueue("nightly", { waiting: 0, active: 0, delayed: 500, failed: 0, completed: 0 })]);
    expect(snapshot.pending).toBe(0);
  });

  it("sums across every queue, since one fleet drains all of them", async () => {
    const snapshot = await readBacklog([
      stubQueue("a", { waiting: 1, active: 1, delayed: 0, failed: 0, completed: 0 }),
      stubQueue("b", { waiting: 4, active: 0, delayed: 0, failed: 0, completed: 0 }),
    ]);
    expect(snapshot.pending).toBe(6);
  });

  it("treats a missing count as zero rather than NaN", async () => {
    // getJobCounts only returns the states asked for, and an older BullMQ or a
    // brand-new queue can answer with a key absent.
    const snapshot = await readBacklog([stubQueue("fresh", {})]);
    expect(snapshot.queues[0].pending).toBe(0);
    expect(snapshot.pending).toBe(0);
  });
});
