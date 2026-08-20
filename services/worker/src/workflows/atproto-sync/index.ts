import { defineWorkflow } from "#/workflows/define.ts";
import { closeDb } from "#/workflows/atproto-sync/lib/db.ts";
import type { AtprotoSyncInput } from "#/workflows/atproto-sync/types.ts";

/**
 * Registration for the atproto sweep — see `#/workflows/define.ts` for what a
 * registration is and what it is not.
 *
 * The sweep used to be a Railway cron service, and this entry is most of what
 * replacing it took. What the move buys: a running sweep is visible in the
 * Temporal UI — every batch, its input, its result, its retries and its
 * durations — instead of only in a log stream; one can be started on demand
 * without touching the dashboard; and a worker dying mid-sweep costs the batch
 * in flight rather than the whole hour's work.
 */
export const atprotoSync = defineWorkflow({
  name: "atproto-sync",
  description: "Sweep the atproto network and reconcile the Postgres recipe index",

  // Only `dryRun` and `batchSize` are per-run. Everything else about a sweep
  // (which relay, which database, how many repos at a time) is environment, read
  // inside the activities — so a scheduled sweep, a sweep started from the UI and
  // `sync:once` from a shell all read the same settings.
  input: (flags): AtprotoSyncInput => ({
    dryRun: flags["dry-run"] === true,
    batchSize: typeof flags["batch-size"] === "string" ? Number(flags["batch-size"]) : undefined,
  }),

  // Hourly on Railway (see .railway/railway.ts), unset locally — a dev machine
  // should not quietly sweep the live atmosphere in the background. Set
  // ATPROTO_SYNC_SCHEDULE in services/worker/.env to turn it on.
  schedule: () => process.env.ATPROTO_SYNC_SCHEDULE || undefined,

  // One sweep at a time, cluster-wide. An hourly schedule plus a sweep that
  // occasionally runs long plus somebody typing `sync:once` is exactly the
  // overlap this prevents — and it is enforced by the workflow id rather than by
  // a lock with a TTL that has to be guessed.
  singleton: true,

  // Generous, and a backstop rather than a target: a full sweep of a few
  // thousand repos runs in minutes. What it actually protects against is a run
  // that has wedged holding the singleton id, which would otherwise block every
  // scheduled sweep after it.
  executionTimeout: "2 hours",

  // The activities open a pg pool on first use and keep it between runs. Ending
  // it on drain is what lets the worker process actually exit.
  close: closeDb,
});
