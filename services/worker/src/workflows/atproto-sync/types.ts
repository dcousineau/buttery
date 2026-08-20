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
   * How many `syncRepo` activities are in flight at once. This is the workflow's
   * share of the decision; how many a single worker will actually execute in
   * parallel is `WORKER_MAX_CONCURRENT_ACTIVITIES`, and across a fleet it is that
   * times the replica count.
   */
  parallelism?: number;
  /**
   * Set by `continueAsNew` and by nothing else — see `workflow.ts`. A sweep long
   * enough to outgrow one execution's history hands its remaining work to a
   * fresh execution through this field.
   */
  continuation?: SweepContinuation;
}

/** The tail of a sweep, handed to the next execution. */
export interface SweepContinuation {
  /** Every DID this sweep is working through, in the order it enumerated them. */
  dids: string[];
  /** How many of them are already done. */
  cursor: number;
  fullSweep: boolean;
  syncRunId: string | null;
  summary: SweepSummary;
}

export type EnumerateInput = SweepScope;
export type RunInput = SweepScope;
export interface SyncRepoInput extends SweepScope {
  did: string;
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

/** What sweeping one repo did. A repo that could not be swept has no outcome — it throws. */
export interface RepoOutcome {
  upserted: number;
  deleted: number;
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
