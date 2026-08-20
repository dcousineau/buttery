import type { Pool } from "pg";
import type { Step } from "#/workflows/define.ts";
import type { SweepSummary } from "#/workflows/atproto-sync/sweep.ts";
import type { SyncConfig } from "#/workflows/atproto-sync/config.ts";
import { RECIPE_COLLECTION } from "#/workflows/atproto-sync/config.ts";
import { closeSyncRun, markMissingRepos, openSyncRun, registerRepos, runPool, sweepDid } from "#/workflows/atproto-sync/sweep.ts";
import { enumerateDids, enumerateDidsFromPds } from "#/workflows/atproto-sync/relay.ts";
import { log } from "#/log.ts";

/**
 * The sweep, as five ordered steps.
 *
 * The algorithm did not change when it became steps — this is the same
 * enumerate → index → reconcile it always was, cut at the seams it already had.
 * What the cut buys is that the board shows which phase an hourly sweep is in
 * and how long each one took, and that a failure names the phase it came out of
 * instead of a stack trace 400 lines into a single function.
 */

export interface SyncState {
  config: SyncConfig;
  pool: Pool;
  /** Every DID this sweep will read, filled by `enumerate`. */
  dids: string[];
  /**
   * Whether this sweep observed the whole network. A partial one (`SYNC_ONLY_DID`
   * / `SYNC_MAX_REPOS` / `SYNC_PDS_URL`) must NOT drive missing-repo
   * reconciliation: it has no basis for calling anything absent.
   */
  fullSweep: boolean;
  syncRunId: string | null;
  summary: SweepSummary;
}

/**
 * Find the DIDs to sweep. Three sources, in precedence order — one DID by name,
 * one PDS's repo list (local dev; the atproto dev-env ships no relay), or the
 * relay's collection index, which is the production path.
 */
const enumerate: Step<SyncState> = {
  name: "enumerate",
  run: async ({ state, log: line }) => {
    const { config } = state;

    if (config.onlyDid) {
      state.dids = [config.onlyDid];
      log.info("single-did sweep", { did: config.onlyDid });
    } else if (config.pdsListUrl) {
      for await (const did of enumerateDidsFromPds(config.pdsListUrl, config.maxRepos)) {
        state.dids.push(did);
      }
      log.info("enumerated repos from pds", { pds: config.pdsListUrl, count: state.dids.length });
    } else {
      for await (const did of enumerateDids(config.relayUrl, RECIPE_COLLECTION, config.maxRepos)) {
        state.dids.push(did);
      }
      log.info("enumerated repos", { count: state.dids.length });
    }

    state.fullSweep = !config.onlyDid && !config.maxRepos && !config.pdsListUrl;
    state.summary.reposSeen = state.dids.length;
    await line(`${state.dids.length} repos to sweep${state.fullSweep ? "" : " (partial sweep)"}`);
  },
};

/**
 * Open the `atproto_sync_run` row and register every discovered DID. Separate
 * from `enumerate` because it is the first step that writes: everything before
 * it is reads, and a dry run stops being a no-op here.
 */
const openRun: Step<SyncState> = {
  name: "open-run",
  run: async ({ state, log: line }) => {
    if (state.config.dryRun) {
      await line("dry run — no sync-run row, no writes");
      return;
    }
    state.syncRunId = await openSyncRun(state.pool, state.config);
    state.summary.syncRunId = state.syncRunId;
    await registerRepos(state.pool, state.dids);
    await line(`sync run ${state.syncRunId} open, ${state.dids.length} repos registered`);
  },
};

/**
 * The work: page each repo's records and upsert them, `SYNC_CONCURRENCY` DIDs at
 * a time.
 *
 * A repo that fails does not fail the sweep. Its error goes to
 * `atproto_repo.last_error` and its count to `repos_failed`, because one repo
 * whose PDS is down should not cost the reconciliation of every other repo — and
 * an hourly sweep that fails whenever any one of thousands of servers is
 * unreachable would simply always be failing.
 */
const index: Step<SyncState> = {
  name: "index",
  run: async ({ state, progress, log: line }) => {
    let done = 0;
    await runPool(state.dids, state.config.concurrency, async (did) => {
      const outcome = await sweepDid(state.pool, state.config, did);
      state.summary.recordsUpserted += outcome.upserted;
      state.summary.recordsDeleted += outcome.deleted;
      if (outcome.failed) state.summary.reposFailed++;
      done++;
      await progress(done / Math.max(state.dids.length, 1));
    });
    await line(`${state.summary.recordsUpserted} upserted, ${state.summary.recordsDeleted} deleted, ${state.summary.reposFailed} repos failed`);
  },
};

/** Flag DIDs that dropped out of enumeration. Full, non-dry sweeps only. */
const reconcile: Step<SyncState> = {
  name: "reconcile",
  run: async ({ state, log: line }) => {
    if (!state.fullSweep || state.config.dryRun) {
      await line("skipped — a partial or dry sweep has not observed the whole network");
      return;
    }
    const count = await markMissingRepos(state.pool, state.dids);
    log.info("marked missing repos", { count });
    await line(`${count} repos newly marked missing`);
  },
};

/** Close the `atproto_sync_run` row. The mirror of `open-run`. */
const closeRun: Step<SyncState> = {
  name: "close-run",
  run: async ({ state, log: line }) => {
    await closeSyncRun(state.pool, state.syncRunId, state.summary, null);
    await line(`sweep complete: ${JSON.stringify(state.summary)}`);
    log.info("sweep complete", { ...state.summary });
  },
};

export const steps: readonly Step<SyncState>[] = [enumerate, openRun, index, reconcile, closeRun];

/**
 * Mark the run row failed when a step throws. Without this a sweep that dies
 * mid-flight leaves an `atproto_sync_run` row saying `running` forever, and the
 * table stops being a usable record of what actually happened.
 */
export async function markRunFailed(state: SyncState, err: unknown): Promise<void> {
  state.summary.status = "error";
  await closeSyncRun(state.pool, state.syncRunId, state.summary, String(err));
}
