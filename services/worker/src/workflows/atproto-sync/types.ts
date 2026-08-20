/**
 * The vocabulary the two halves of this workflow exchange.
 *
 * It lives in a file of its own because of where those halves run: the workflow
 * side is bundled into a deterministic sandbox, the activity side runs in plain
 * Node, and everything crossing between them is serialized to JSON and written
 * into the workflow's history. These types are the wire format — keep them
 * small, keep them JSON, and remember that anything here is replayed on every
 * worker that ever picks the run back up.
 *
 * No imports, deliberately. A type file that pulled in `pg` would drag the
 * driver into the workflow bundle the first time someone forgot an `import type`.
 */

/**
 * What a single sweep is scoped to. Every field is optional and every field
 * falls back to the environment (see `lib/config.ts`), which is the split this
 * service holds to: the environment says which atmosphere this deployment reads,
 * an argument says what this one run should do differently.
 */
export interface SweepScope {
  /** Fetch and log, write nothing. */
  dryRun?: boolean;
  /** Stop after N DIDs. Overrides `SYNC_MAX_REPOS`. */
  maxRepos?: number;
  /** Sweep just this DID. Overrides `SYNC_ONLY_DID`. */
  onlyDid?: string;
}

/** The `atprotoSync` workflow's one argument. */
export interface AtprotoSyncInput extends SweepScope {
  /**
   * DIDs per `indexRepoBatch` activity. The batch size is the unit of retry and
   * the unit of progress: smaller batches mean a failed PDS costs less work and
   * the timeline moves more often, at the cost of one more history event each.
   */
  batchSize?: number;
}

export type EnumerateInput = SweepScope;
export type RunInput = SweepScope;
export interface IndexBatchInput extends SweepScope {
  dids: string[];
}
export interface ReconcileInput {
  dids: string[];
}
export interface CloseRunInput {
  syncRunId: string | null;
  summary: SweepSummary;
  error: string | null;
}

/** What `enumerateRepos` found. */
export interface EnumerateResult {
  dids: string[];
  /**
   * Whether this sweep observed the whole network. A partial one (a scoped
   * `maxRepos` / `onlyDid`, or a single-PDS deployment) must NOT drive
   * missing-repo reconciliation: it has no basis for calling anything absent.
   */
  fullSweep: boolean;
}

/** What one `indexRepoBatch` did, folded across its DIDs. */
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
