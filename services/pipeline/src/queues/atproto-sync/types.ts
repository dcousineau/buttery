/**
 * The vocabulary the two halves of this sweep exchange.
 *
 * It lives in a file of its own because of where those halves run: the batch
 * job (`enumerate`/`finalize`) and the per-repo job (`sync-repo`) are separate
 * jobs on the same queue, often picked up by separate worker replicas, and
 * everything crossing between them is JSON in Redis. These types are that wire
 * format — keep them small, keep them JSON, and remember that a job enqueued by
 * one deployment may be picked up by the next.
 */

/**
 * What a single sweep is scoped to. Every field is optional and every field
 * falls back to the environment (see `lib/config.ts`), which is the split this
 * service holds to: the environment says which atmosphere this deployment reads,
 * a job payload says what this one run should do differently.
 */
export interface SweepScope {
  /** Fetch and log, write nothing. */
  dryRun?: boolean;
  /** Stop after N DIDs. Overrides `SYNC_MAX_REPOS`. */
  maxRepos?: number;
  /** Sweep just this DID. Overrides `SYNC_ONLY_DID`. */
  onlyDid?: string;
}

/** The payload of one `sync-repo` job: a scope, plus which repo. */
export interface SyncRepoPayload extends SweepScope {
  did: string;
  /** Recorded on the job so the board shows which sweep a repo belongs to. */
  syncRunId: string | null;
}

/**
 * What sweeping one repo did, and what the per-repo job returns. A repo that
 * could not be swept has no outcome — its job fails, which is how it asks for
 * the retry it deserves.
 */
export interface RepoOutcome {
  did: string;
  upserted: number;
  deleted: number;
}

/** `finalize`'s return value, and the shape of the `atproto_sync_run` row. */
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

/**
 * The payload of the `finalize` job: everything the tail of a sweep needs that
 * the repo jobs cannot tell it. It is written by `enumerate` when it submits the
 * flow, and read minutes or hours later on whichever replica picks the job up.
 */
export interface FinalizePayload extends SweepScope {
  /**
   * Every DID this sweep enumerated — not just the ones that worked.
   * Reconciliation marks the repos that were *absent* from the network, and a
   * repo whose PDS was down has not gone missing.
   */
  dids: string[];
  fullSweep: boolean;
  syncRunId: string | null;
  /** The `enumerate` job's lock token. `finalize` is where it is released. */
  lock: string;
}
