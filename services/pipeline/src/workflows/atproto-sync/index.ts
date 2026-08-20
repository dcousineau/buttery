import { defineWorkflow } from "#/workflows/define.ts";
import { closeDb } from "#/workflows/atproto-sync/lib/db.ts";
import { steps } from "#/workflows/atproto-sync/steps.ts";

/**
 * Sweep the atproto network and reconcile the Postgres recipe index.
 *
 * This was a Railway cron service. It is a scheduled BullMQ workflow now, which
 * buys three things the cron did not have: the sweep is visible in the Bull
 * Board UI while it runs — as a job per repo, with its own payload, log, retries
 * and duration — rather than only in a log stream; a sweep can be triggered on
 * demand with `POST /jobs/atproto-sync` without touching the dashboard; and it
 * spreads over the same autoscaled fleet as every other workflow instead of
 * looping alone in a container of its own.
 *
 * The graph is three steps — see `steps.ts`:
 *
 *     enumerate ──fans out──▶ sync-repo × N ──▶ finalize
 *
 * Everything it needs is in this folder:
 *
 *   steps.ts     the three steps and the flow between them
 *   plan.ts      folding repo results into a summary — pure, and tested
 *   types.ts     what the steps hand each other, which is JSON in Redis
 *   lib/         the work itself, unchanged from when this was its own package:
 *                sweep.ts (one repo, and the run bookkeeping), config.ts,
 *                relay.ts + pds.ts + identity.ts + http.ts (the network),
 *                recipe.ts + render.ts (the writes), db.ts (the pool)
 */
export const atprotoSync = defineWorkflow({
  name: "atproto-sync",
  description: "Sweep the atproto network and reconcile the Postgres recipe index",
  entry: "enumerate",
  steps,

  // Hourly on Railway (see .railway/railway.ts), unset locally — a dev machine
  // should not quietly sweep the live atmosphere in the background. Set
  // ATPROTO_SYNC_SCHEDULE in services/pipeline/.env to turn it on.
  schedule: () => process.env.ATPROTO_SYNC_SCHEDULE || undefined,

  // How many repos this sweep may have in flight at once, across every replica.
  // The sweep fans out every repo it found in one call and lets the queue hold
  // them; this is what decides how many of them actually run, and it is the only
  // limit that survives the autoscaler changing the replica count underneath it.
  //
  // Eight is a polite number of simultaneous requests to point at the atmosphere
  // from one sweep. Raise it in the environment when a sweep's wall-clock starts
  // to matter more than that politeness does.
  globalConcurrency: () => Number(process.env.ATPROTO_SYNC_MAX_IN_FLIGHT || 8) || undefined,

  // The sweep opens a pg pool on first use and reuses it across runs. Ending it
  // on drain is what lets a scaled-down replica's process actually exit.
  close: closeDb,
});
