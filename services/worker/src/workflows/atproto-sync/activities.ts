import { heartbeat } from "@temporalio/activity";
import { isFullSweep, loadSyncConfig, RECIPE_COLLECTION } from "#/workflows/atproto-sync/lib/config.ts";
import { getPool } from "#/workflows/atproto-sync/lib/db.ts";
import { enumerateDids, enumerateDidsFromPds } from "#/workflows/atproto-sync/lib/relay.ts";
import { closeSyncRun as closeRunRow, markMissingRepos, openSyncRun as openRunRow, sweepRepos } from "#/workflows/atproto-sync/lib/sweep.ts";
import type { BatchOutcome, EnumerateResult, SweepSummary } from "#/workflows/atproto-sync/types.ts";
import { log } from "#/log.ts";

/**
 * The sweep's activities: the only place in this workflow that is allowed to
 * touch the network, the database or the environment.
 *
 * Each one is deliberately thin. An activity's job is to be a *retry boundary* —
 * a named unit of work Temporal can re-run on another machine — so the code here
 * is the wrapper (read config, take the pool, heartbeat) and `lib/` is the work.
 * Keeping them thin is also what keeps them honest about the contract every
 * activity signs: **it may run more than once**. Each of these is idempotent —
 * every write in the sweep is a rev-guarded upsert — which is why a retried
 * batch converges rather than double-counting.
 *
 * One argument, one object, always. Temporal serializes activity arguments
 * positionally, so a second parameter added later is a breaking change for
 * in-flight runs, while a new field on an object argument is not.
 */

/**
 * Find the DIDs to sweep. Three sources, in precedence order — one DID by name,
 * one PDS's repo list (local dev; the atproto dev-env ships no relay), or the
 * relay's collection index, which is the production path.
 */
export async function enumerateRepos(input: { dryRun: boolean }): Promise<EnumerateResult> {
  const config = loadSyncConfig(input.dryRun);
  const dids: string[] = [];

  if (config.onlyDid) {
    dids.push(config.onlyDid);
    log.info("single-did sweep", { did: config.onlyDid });
  } else if (config.pdsListUrl) {
    for await (const did of enumerateDidsFromPds(config.pdsListUrl, config.maxRepos)) {
      dids.push(did);
      // Enumeration can page for a while against a slow relay. Heartbeating per
      // DID is what distinguishes that from a worker that has stopped.
      heartbeat(dids.length);
    }
    log.info("enumerated repos from pds", { pds: config.pdsListUrl, count: dids.length });
  } else {
    for await (const did of enumerateDids(config.relayUrl, RECIPE_COLLECTION, config.maxRepos)) {
      dids.push(did);
      heartbeat(dids.length);
    }
    log.info("enumerated repos", { count: dids.length });
  }

  return { dids, fullSweep: isFullSweep(config) };
}

/** Open the `atproto_sync_run` row. Returns null on a dry run, which writes nothing. */
export async function openSyncRun(input: { dryRun: boolean }): Promise<string | null> {
  const config = loadSyncConfig(input.dryRun);
  return openRunRow(getPool(config.databaseUrl), config);
}

/** Page and upsert one slice of the network. See `lib/sweep.ts`. */
export async function indexRepoBatch(input: { dids: string[]; dryRun: boolean }): Promise<BatchOutcome> {
  const config = loadSyncConfig(input.dryRun);
  return sweepRepos(getPool(config.databaseUrl), config, input.dids, (done, total) => heartbeat({ done, total }));
}

/** Flag DIDs that dropped out of enumeration. Full, non-dry sweeps only — the workflow decides. */
export async function reconcileMissingRepos(input: { dids: string[] }): Promise<number> {
  const config = loadSyncConfig();
  const count = await markMissingRepos(getPool(config.databaseUrl), input.dids);
  log.info("marked missing repos", { count });
  return count;
}

/** Close the `atproto_sync_run` row. The mirror of `openSyncRun`. */
export async function closeSyncRun(input: { syncRunId: string | null; summary: SweepSummary; error: string | null }): Promise<void> {
  const config = loadSyncConfig(input.summary.dryRun);
  await closeRunRow(getPool(config.databaseUrl), input.syncRunId, input.summary, input.error);
  log.info("sweep run closed", { ...input.summary, error: input.error });
}
