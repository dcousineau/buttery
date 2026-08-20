import { heartbeat } from "@temporalio/activity";
import type { Pool } from "pg";
import { loadSyncConfig, RECIPE_COLLECTION } from "#/workflows/atproto-sync/lib/config.ts";
import { enumerateDids, enumerateDidsFromPds } from "#/workflows/atproto-sync/lib/relay.ts";
import { closeSyncRun, markMissingRepos, openSyncRun, sweepRepos } from "#/workflows/atproto-sync/lib/sweep.ts";
import type { CloseRunInput, EnumerateInput, EnumerateResult, IndexBatchInput, ReconcileInput, RunInput } from "#/workflows/atproto-sync/types.ts";
import { log } from "#/log.ts";

/**
 * The sweep's activities: the only place in this workflow allowed to touch the
 * network, the database or the environment.
 *
 * Each one is thin on purpose. An activity's job is to be a *retry boundary* — a
 * named unit of work Temporal can re-run on another machine — so the code here is
 * the wrapper (resolve config, heartbeat) and `lib/` is the work. Thin is also
 * what keeps them honest about the contract every activity signs: **it may run
 * more than once**. Each of these is idempotent, because every write in the sweep
 * is a rev-guarded upsert, which is why a retried batch converges rather than
 * double-counting.
 *
 * Every activity takes one object. Temporal serializes arguments positionally, so
 * a second parameter added later is a breaking change for in-flight runs while a
 * new field on an object argument is not.
 */
export function createAtprotoSyncActivities({ pool }: { pool: Pool }) {
  return {
    /**
     * Find the DIDs to sweep. Three sources, in precedence order — one DID by
     * name, one PDS's repo list (local dev; the atproto dev-env ships no relay),
     * or the relay's collection index, which is the production path.
     */
    async enumerateRepos(input: EnumerateInput): Promise<EnumerateResult> {
      const config = loadSyncConfig(input);
      const dids: string[] = [];

      if (config.onlyDid) {
        dids.push(config.onlyDid);
        log.info("single-did sweep", { did: config.onlyDid });
      } else if (config.pdsListUrl) {
        for await (const did of enumerateDidsFromPds(config.pdsListUrl, config.maxRepos)) {
          dids.push(did);
          // Enumeration can page for a while against a slow relay. Heartbeating
          // is what distinguishes that from a worker that has stopped.
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

      return { dids, fullSweep: config.fullSweep };
    },

    /** Open the `atproto_sync_run` row. Returns null on a dry run, which writes nothing. */
    async openSyncRun(input: RunInput): Promise<string | null> {
      return openSyncRun(pool, loadSyncConfig(input));
    },

    /** Page and upsert one slice of the network. See `lib/sweep.ts`. */
    async indexRepoBatch(input: IndexBatchInput) {
      const config = loadSyncConfig(input);
      return sweepRepos(pool, config, input.dids, (done, total) => heartbeat({ done, total }));
    },

    /** Flag DIDs that dropped out of enumeration. The workflow decides when this applies. */
    async reconcileMissingRepos(input: ReconcileInput): Promise<number> {
      const count = await markMissingRepos(pool, input.dids);
      log.info("marked missing repos", { count });
      return count;
    },

    /** Close the `atproto_sync_run` row. The mirror of `openSyncRun`. */
    async closeSyncRun(input: CloseRunInput): Promise<void> {
      await closeSyncRun(pool, input.syncRunId, input.summary, input.error);
      log.info("sweep run closed", { ...input.summary, error: input.error });
    },
  };
}

/** What `proxyActivities` is parameterised by on the workflow side. */
export type AtprotoSyncActivities = ReturnType<typeof createAtprotoSyncActivities>;
