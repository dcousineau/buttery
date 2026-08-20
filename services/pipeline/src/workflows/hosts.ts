import type { Job } from "bullmq";
import { log } from "#/log.ts";
import { STEP_CURSOR_KEY, type WorkflowHost } from "#/workflows/define.ts";

/**
 * The two things a workflow run can report to: a BullMQ job, and a terminal.
 *
 * Both drivers go through `Workflow.run`, so a sweep started by the scheduler
 * and a sweep started by `sync:once` execute the same steps in the same order —
 * the only difference is where the progress and the log lines land.
 */

function asRecord(data: unknown): Record<string, unknown> {
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
}

export function jobHost(job: Job): WorkflowHost {
  return {
    runId: `job:${job.id ?? "?"}`,
    // `job.log` resolves to the log's new length; the kernel wants nothing back.
    log: async (message) => {
      await job.log(message);
    },
    progress: (fraction) => job.updateProgress(Math.round(fraction * 100)),
    readCursor: () => {
      const cursor = asRecord(job.data)[STEP_CURSOR_KEY];
      return typeof cursor === "string" ? cursor : undefined;
    },
    // Merged into the payload rather than replacing it: `updateData` overwrites,
    // and the payload has to survive for the steps that read it after a resume.
    writeCursor: (step) => job.updateData({ ...asRecord(job.data), [STEP_CURSOR_KEY]: step }),
  };
}

/**
 * For `run-once.ts`. There is no job to hang a cursor on, so a run started here
 * always runs every step — which is what a person typing a command expects
 * anyway.
 */
export function consoleHost(workflow: string): WorkflowHost {
  return {
    runId: "cli",
    log: (message) => {
      log.info(message.trim(), { workflow });
      return Promise.resolve();
    },
    progress: () => Promise.resolve(),
    readCursor: () => undefined,
    writeCursor: () => Promise.resolve(),
  };
}
