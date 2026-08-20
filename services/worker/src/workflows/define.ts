import type { Duration } from "@temporalio/common";

/**
 * What a workflow is *to this service* — which is much less than it is to
 * Temporal, and that is the interesting part.
 *
 * Temporal already owns the things a queue library makes you build: the step
 * cursor (workflow history), the retry policy, the "run this hourly" scheduler,
 * the "don't start a second one" interlock, the dashboard. So there is no
 * kernel here that runs a workflow — `workflow.ts` runs itself, on the worker,
 * and the code in this file never executes during a run.
 *
 * What is left is *registration*: the handful of facts the processes around a
 * workflow need in order to reach it.
 *
 *   * `worker.ts` needs the task queue and the activity implementations.
 *   * `schedules-sync.ts` needs the cron pattern, the input a scheduled run
 *     gets, and the id to reconcile it under.
 *   * `run-once.ts` needs to turn `--flags` into that same input.
 *
 * A workflow is therefore a folder and one entry in `WORKFLOWS` (`index.ts`):
 *
 *   atproto-sync/
 *     index.ts       this registration — the only file the rest of the service reads
 *     workflow.ts    the entrypoint that runs in the sandbox: orchestration, nothing else
 *     plan.ts        pure helpers `workflow.ts` calls (see the sandbox rule below)
 *     activities.ts  the activity entrypoints — thin wrappers over lib/
 *     types.ts       the types the two sides exchange
 *     lib/           what the activities actually do: pg, fetch, atproto
 *
 * **The sandbox rule.** `workflow.ts` and anything it imports are bundled by the
 * worker and run in an isolate with no I/O, no `process`, no `Date.now()` and no
 * `Math.random()`. So it may import `types.ts` and `plan.ts` (pure), and it may
 * import `activities.ts` **for its types only** (`import type`, erased at
 * compile time). Reaching into `lib/` from a workflow is the one mistake this
 * layout is shaped to prevent, and `bundle.test.ts` fails the build when someone
 * makes it anyway.
 */

export interface WorkflowRegistration {
  /**
   * The workflow *type*, which must equal the name `bundle.ts` exports the
   * entrypoint under — that string is what the client puts in a StartWorkflow
   * request and what the worker looks up in the bundle. Renaming one without the
   * other produces a workflow that starts and then fails "not registered", so
   * they are asserted equal by `registry.test.ts`.
   */
  name: string;
  /** One line, for `run:once --help` and the README. */
  description: string;
  /**
   * Turn `run:once` flags into the workflow's input argument. Also the place a
   * schedule's input comes from (called with no flags), so a scheduled run and a
   * hand-started one cannot drift into different shapes.
   */
  input: (flags: Flags) => unknown;
  /**
   * Cron pattern (UTC) this workflow runs on, or `undefined` for "only when
   * something starts it". A function rather than a value because it is read from
   * the environment, and module evaluation order should not decide whether that
   * environment has been loaded yet. Reconciled into Temporal Schedules by
   * `schedules-sync.ts`; emptying the variable *removes* the schedule.
   */
  schedule?: () => string | undefined;
  /**
   * One execution at a time, cluster-wide. Implemented as a fixed workflow id
   * (the workflow's name), which Temporal refuses to start twice concurrently —
   * so a scheduled sweep and someone running `sync:once` cannot overlap, and
   * neither can two replicas. The BullMQ build needed a Redis mutex with a TTL
   * for this; here it is a property of the id.
   */
  singleton?: boolean;
  /**
   * Wall-clock ceiling for one execution, retries included. Temporal will
   * terminate a run that exceeds it, which is the backstop against a workflow
   * that has quietly wedged holding a singleton id.
   */
  executionTimeout?: Duration;
  /** Released when the worker drains: a database pool, an open file, a client. */
  close?: () => Promise<void>;
}

/** Parsed `run:once` flags: `--dry-run` → `true`, `--max=25` → `"25"`. */
export type Flags = Record<string, string | boolean>;

/** Identity, with the type named. Present so a registration reads like a declaration. */
export function defineWorkflow(registration: WorkflowRegistration): WorkflowRegistration {
  return registration;
}

/** `--dry-run` and friends, tolerant of `--flag`, `--flag=value` and `--flag value`. */
export function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [name, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) {
      flags[name] = inline;
    } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
      flags[name] = argv[++i];
    } else {
      flags[name] = true;
    }
  }
  return flags;
}
