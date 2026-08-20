import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { SKIPPED, defineWorkflow, type Step, type WorkflowHost } from "#/workflows/define.ts";

/**
 * The kernel, on its own. Everything here is in-memory: a recording host stands
 * in for a BullMQ job, and a two-method stub stands in for Redis, so the ordering
 * and resume rules every workflow inherits are pinned without a running stack.
 */

interface Recorded {
  host: WorkflowHost;
  lines: string[];
  progress: number[];
  cursorWrites: string[];
}

function recordingHost(cursor?: string): Recorded {
  const lines: string[] = [];
  const progress: number[] = [];
  const cursorWrites: string[] = [];
  let current = cursor;
  return {
    lines,
    progress,
    cursorWrites,
    host: {
      runId: "test",
      log: (message) => {
        lines.push(message.trim());
        return Promise.resolve();
      },
      progress: (fraction) => {
        progress.push(fraction);
        return Promise.resolve();
      },
      readCursor: () => current,
      writeCursor: (step) => {
        cursorWrites.push(step);
        current = step;
        return Promise.resolve();
      },
    },
  };
}

/** Enough of ioredis for `withLock`: SET NX PX, and the two eval'd scripts. */
function fakeRedis(acquires: boolean): Redis {
  return {
    set: () => Promise.resolve(acquires ? "OK" : null),
    eval: () => Promise.resolve(1),
  } as unknown as Redis;
}

interface Trace {
  ran: string[];
}

function tracer(name: string, run?: (state: Trace) => Promise<void>): Step<Trace> {
  return {
    name,
    run: async ({ state }) => {
      state.ran.push(name);
      await run?.(state);
    },
  };
}

function threeSteps(overrides: Partial<Parameters<typeof defineWorkflow<Trace>>[0]> = {}) {
  return defineWorkflow<Trace>({
    name: "test",
    description: "test workflow",
    start: () => ({ ran: [] }),
    steps: [tracer("one"), tracer("two"), tracer("three")],
    result: (state) => state.ran,
    ...overrides,
  });
}

describe("defineWorkflow", () => {
  it("runs every step in order and returns what `result` shapes", async () => {
    const recorded = recordingHost();
    const result = await threeSteps().run({ payload: {}, host: recorded.host, redis: fakeRedis(true) });

    expect(result).toEqual(["one", "two", "three"]);
  });

  it("advances progress to 1 across the steps, scaling what a step reports", async () => {
    const recorded = recordingHost();
    const workflow = defineWorkflow<Trace>({
      name: "test",
      description: "test workflow",
      start: () => ({ ran: [] }),
      // The first step reports halfway through itself: half of one step out of
      // two is a quarter of the job.
      steps: [{ name: "one", run: async ({ progress }) => progress(0.5) }, tracer("two")],
    });

    await workflow.run({ payload: {}, host: recorded.host, redis: fakeRedis(true) });

    expect(recorded.progress).toEqual([0.25, 0.5, 1]);
  });

  it("exposes step names for `/workflows` without exposing the steps themselves", () => {
    expect(threeSteps().steps).toEqual(["one", "two", "three"]);
  });

  it("rethrows the original error and runs `onFailure` first", async () => {
    const boom = new Error("boom");
    const failures: unknown[] = [];
    const workflow = defineWorkflow<Trace>({
      name: "test",
      description: "test workflow",
      start: () => ({ ran: [] }),
      steps: [
        tracer("one"),
        tracer("two", () => {
          throw boom;
        }),
        tracer("three"),
      ],
      onFailure: (state, err) => {
        // The state as it stood when the step failed, not a fresh one.
        failures.push({ ran: [...state.ran], err });
        return Promise.resolve();
      },
    });

    const recorded = recordingHost();
    await expect(workflow.run({ payload: {}, host: recorded.host, redis: fakeRedis(true) })).rejects.toBe(boom);
    expect(failures).toEqual([{ ran: ["one", "two"], err: boom }]);
    expect(recorded.lines).toContain('step "two" FAILED: Error: boom');
  });

  it("does not let a failing `onFailure` replace the failure that caused it", async () => {
    const boom = new Error("boom");
    const workflow = threeSteps({
      steps: [
        tracer("one", () => {
          throw boom;
        }),
      ],
      onFailure: () => Promise.reject(new Error("cleanup also failed")),
    });

    const recorded = recordingHost();
    await expect(workflow.run({ payload: {}, host: recorded.host, redis: fakeRedis(true) })).rejects.toBe(boom);
  });

  describe("resumeOnRetry", () => {
    it("writes a cursor per step and resumes at it", async () => {
      const first = recordingHost();
      await threeSteps({ resumeOnRetry: true }).run({ payload: {}, host: first.host, redis: fakeRedis(true) });
      expect(first.cursorWrites).toEqual(["one", "two", "three"]);

      // A retry of a job that died on "two" picks up there.
      const retry = recordingHost("two");
      const result = await threeSteps({ resumeOnRetry: true }).run({ payload: {}, host: retry.host, redis: fakeRedis(true) });
      expect(result).toEqual(["two", "three"]);
    });

    it("starts over when the cursor names a step this build no longer has", async () => {
      const recorded = recordingHost("a-step-that-was-renamed");
      const result = await threeSteps({ resumeOnRetry: true }).run({ payload: {}, host: recorded.host, redis: fakeRedis(true) });

      expect(result).toEqual(["one", "two", "three"]);
    });

    it("is off by default: an existing cursor is neither read nor written", async () => {
      const recorded = recordingHost("two");
      const result = await threeSteps().run({ payload: {}, host: recorded.host, redis: fakeRedis(true) });

      expect(result).toEqual(["one", "two", "three"]);
      expect(recorded.cursorWrites).toEqual([]);
    });
  });

  describe("exclusive", () => {
    const exclusive = { key: "test:lock", ttlMs: 1_000 };

    it("runs when it takes the lock", async () => {
      const recorded = recordingHost();
      const result = await threeSteps({ exclusive }).run({ payload: {}, host: recorded.host, redis: fakeRedis(true) });

      expect(result).toEqual(["one", "two", "three"]);
    });

    it("skips rather than fails when someone else holds it", async () => {
      const recorded = recordingHost();
      const result = await threeSteps({ exclusive }).run({ payload: {}, host: recorded.host, redis: fakeRedis(false) });

      expect(result).toBe(SKIPPED);
      expect(recorded.lines.at(-1)).toBe('skipped: another run of "test" holds the lock');
    });

    it("tells a run that legitimately returned nothing apart from a skipped one", async () => {
      const recorded = recordingHost();
      // No `result`, so the run resolves to undefined — which is exactly what
      // `withLock` returns when it could not acquire. The two must not collide.
      const result = await threeSteps({ exclusive, result: undefined }).run({ payload: {}, host: recorded.host, redis: fakeRedis(true) });

      expect(result).toBeUndefined();
      expect(result).not.toBe(SKIPPED);
    });
  });
});
