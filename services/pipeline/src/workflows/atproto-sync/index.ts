import { defineWorkflow } from "#/workflows/define.ts";
import { getPool } from "#/workflows/atproto-sync/db.ts";
import { closeDb } from "#/workflows/atproto-sync/db.ts";
import { loadSyncConfig } from "#/workflows/atproto-sync/config.ts";
import { markRunFailed, steps, type SyncState } from "#/workflows/atproto-sync/steps.ts";

/**
 * Sweep the atproto network and reconcile the Postgres recipe index.
 *
 * This was a Railway cron service. It is a scheduled BullMQ workflow now, which
 * buys three things the cron did not have: the sweep is visible in the Bull
 * Board UI while it runs — step by step, with progress, logs, durations and
 * failures — rather than only in a log stream; a sweep can be triggered on
 * demand with `POST /jobs/atproto-sync` without touching the dashboard; and it
 * competes for the same autoscaled fleet as every other workflow instead of
 * booting a container of its own.
 *
 * Everything it needs is in this folder:
 *
 *   steps.ts     the five phases, in order — this file's `steps`
 *   sweep.ts     what happens to one repo, and the run/repo bookkeeping rows
 *   config.ts    which network to read and where to write it
 *   relay.ts     DID discovery      pds.ts       record listing
 *   identity.ts  DID → PDS + handle http.ts      the retrying fetch under those
 *   recipe.ts    the raw upsert     render.ts    the normalized/search layer
 *   db.ts        the shared pg pool cli.ts       one sweep from a shell
 */

interface SyncPayload {
  /** `--dry-run`: fetch and log, write nothing. */
  dryRun: boolean;
}

function parse(data: unknown): SyncPayload {
  const raw = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  return { dryRun: raw.dryRun === true };
}

export const atprotoSync = defineWorkflow<SyncState>({
  name: "atproto-sync",
  description: "Sweep the atproto network and reconcile the Postgres recipe index",

  start: (payload) => {
    // RELAY_URL, SYNC_PDS_URL, SYNC_CONCURRENCY and friends, from
    // `services/pipeline/.env` — so a scheduled sweep, a sweep triggered from
    // the board and `sync:once` from a shell all read the same settings. Only
    // `dryRun` comes from the payload, because only it is per-run.
    const config = { ...loadSyncConfig(), dryRun: parse(payload).dryRun };
    return {
      config,
      pool: getPool(config.databaseUrl),
      dids: [],
      fullSweep: false,
      syncRunId: null,
      summary: {
        syncRunId: null,
        status: "ok",
        reposSeen: 0,
        recordsUpserted: 0,
        recordsDeleted: 0,
        reposFailed: 0,
        dryRun: config.dryRun,
      },
    };
  },

  steps,
  result: (state) => state.summary,
  onFailure: markRunFailed,

  // Deliberately NOT resumable. `index` and `reconcile` both need the DID list
  // that `enumerate` produced, and that list is in memory: it can run to
  // thousands of DIDs, which has no business being round-tripped through Redis
  // on every step boundary. Restarting is cheap in correctness terms anyway —
  // every write in the sweep is a rev-guarded idempotent upsert, so a second
  // pass over a half-swept network converges to the same rows.
  resumeOnRetry: false,

  // One sweep at a time across the whole fleet. `concurrency: 1` gets that
  // within a process; this gets it between replicas, which is what an hourly
  // schedule plus a sweep that runs long actually needs. The TTL is generous
  // because it only matters once a holder has STOPPED heartbeating: a live sweep
  // extends it as long as it needs, a crashed one blocks at most this long.
  exclusive: { key: "pipeline:lock:atproto-sync", ttlMs: 15 * 60_000 },
  concurrency: 1,

  // Hourly on Railway (see .railway/railway.ts), unset locally — a dev machine
  // should not quietly sweep the live atmosphere in the background. Set
  // ATPROTO_SYNC_SCHEDULE in services/pipeline/.env to turn it on.
  schedule: () => process.env.ATPROTO_SYNC_SCHEDULE || undefined,

  defaultJobOptions: {
    // A sweep is long and network-bound; two retries with a long backoff cover a
    // relay hiccup without hammering it. A third attempt would land inside the
    // next scheduled sweep anyway.
    attempts: 2,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  },

  // The sweep opens a pg pool on first use and reuses it across runs. Ending it
  // on drain is what lets a scaled-down replica's process actually exit.
  close: closeDb,
});
