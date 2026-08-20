/**
 * The vocabulary the two halves of this workflow exchange.
 *
 * It lives in a file of its own because of where those halves run: the workflow
 * side is bundled into a deterministic sandbox and the activity side runs in
 * plain Node, and everything crossing between them is serialized to JSON and
 * written into the workflow's history. So these types are the wire format —
 * keep them small, keep them JSON, and remember that anything here is replayed
 * on every worker that ever picks the run back up.
 *
 * No imports, deliberately. A type file that pulls in `pg` would drag the driver
 * into the workflow bundle the first time someone forgot an `import type`.
 */

/** What one sweep was asked to do. Everything else comes from the environment. */
export interface AtprotoSyncInput {
  /** Fetch and log, write nothing. `run:once atproto-sync --dry-run`. */
  dryRun?: boolean;
  /**
   * DIDs per `indexRepoBatch` activity. The batch size is the unit of retry and
   * the unit of progress: smaller batches mean a failed PDS costs less work and
   * the UI moves more often, at the cost of one more history event each. 100 is
   * a few seconds of work per batch at the default concurrency.
   */
  batchSize?: number;
}

/** What `enumerateRepos` found. */
export interface EnumerateResult {
  dids: string[];
  /**
   * Whether this sweep observed the whole network. A partial one
   * (`SYNC_ONLY_DID` / `SYNC_MAX_REPOS` / `SYNC_PDS_URL`) must NOT drive
   * missing-repo reconciliation: it has no basis for calling anything absent.
   */
  fullSweep: boolean;
}

/** What one `indexRepoBatch` activity did, folded across its DIDs. */
export interface BatchOutcome {
  recordsUpserted: number;
  recordsDeleted: number;
  reposFailed: number;
}

/** The workflow's return value, and the shape of the `atproto_sync_run` row. */
export interface SweepSummary {
  syncRunId: string | null;
  status: "ok" | "error";
  reposSeen: number;
  recordsUpserted: number;
  recordsDeleted: number;
  reposFailed: number;
  /** Repos that dropped out of enumeration this sweep. Full, non-dry sweeps only. */
  reposMarkedMissing: number;
  dryRun: boolean;
}
