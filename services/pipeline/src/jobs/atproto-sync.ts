import { closeDb, loadConfig as loadSyncConfig, runSweep } from "@buttery/atproto-cron-sync";
import type { Job } from "bullmq";
import type { PipelineDefinition } from "#/jobs/index.ts";
import { withLock } from "#/lock.ts";
import { log } from "#/log.ts";
import { requireRedis } from "#/redis.ts";

/**
 * Sweep the atproto network and reconcile the Postgres recipe index.
 *
 * This was a Railway cron service. It is a scheduled BullMQ job now, which buys
 * three things the cron did not have: the sweep is visible in the Bull Board UI
 * while it runs (progress, logs, duration, failures) rather than only in a log
 * stream; a sweep can be triggered on demand with `POST /jobs/atproto-sync`
 * without touching the dashboard; and it competes for the same autoscaled fleet
 * as every other pipeline instead of booting a container of its own.
 *
 * The sweep itself is unchanged and still lives in @buttery/atproto-cron-sync —
 * this file schedules and supervises it, it does not reimplement it. That
 * package's CLI (`sync:once`) is still the way to run one by hand, and its
 * `.env` is still what decides which network gets swept.
 */

// --- overlap ---------------------------------------------------------------

const LOCK_KEY = "pipeline:lock:atproto-sync";

// Generous, because it only ever matters when a holder has *stopped*
// heartbeating: a live sweep extends it every ~5 minutes for as long as it
// needs, and a crashed one blocks at most this long before the next attempt.
const LOCK_TTL_MS = 15 * 60_000;

// --- the job ---------------------------------------------------------------

interface SyncPayload {
  /** `--dry-run`: fetch and log, write nothing. */
  dryRun: boolean;
}

function parse(data: unknown): SyncPayload {
  const raw = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  return { dryRun: raw.dryRun === true };
}

// Named for what it does rather than for the field it fills: this module reads
// `process.env` below, and a local `process` would shadow the Node global.
async function runSweepJob(job: Job): Promise<unknown> {
  const payload = parse(job.data);
  // Configuration still comes from @buttery/atproto-cron-sync's own environment
  // — RELAY_URL, SYNC_PDS_URL, SYNC_CONCURRENCY and friends — so a scheduled
  // sweep and a `sync:once` from a shell read exactly the same settings.
  const config = { ...loadSyncConfig([]), dryRun: payload.dryRun };

  const result = await withLock(requireRedis(), LOCK_KEY, { ttlMs: LOCK_TTL_MS }, async () => {
    await job.log("sweep started");
    const summary = await runSweep(config);
    log.info("sweep complete", { jobId: job.id, ...summary });
    await job.log(`sweep complete: ${JSON.stringify(summary)}`);
    return summary;
  });

  if (!result) {
    // Not a failure: the work is being done right now by someone else, and
    // failing would only add a retry that hits the same lock. Skipping one
    // hourly sweep costs nothing — the next one reconciles everything the
    // skipped one would have.
    log.warn("sweep skipped — another sweep holds the lock", { jobId: job.id });
    await job.log("skipped: another sweep is already running");
    return { status: "skipped" };
  }

  // The sweep reports a failed status rather than throwing when individual repos
  // fail; surface that as a failed job so it shows up in the board's failed tab.
  if (result.status !== "ok") {
    throw new Error(`sweep finished with status "${result.status}" (${result.reposFailed} repos failed)`);
  }

  return result;
}

export const atprotoSyncPipeline: PipelineDefinition = {
  name: "atproto-sync",
  description: "Sweep the atproto network and reconcile the Postgres recipe index",
  // One sweep per process. Combined with the Redis lock above, that is one
  // sweep across the whole fleet.
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
  process: runSweepJob,
  // The sweep opens a pg pool on first use and reuses it across runs. Ending it
  // on drain is what lets a scaled-down replica's process actually exit.
  close: closeDb,
};
