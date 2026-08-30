// Environment parsing for a sweep. Node runs this `.ts` directly
// (type-stripping) — keep everything erasable (no enum/namespace/param-props).
//
// This is the sweep's own configuration, separate from the service's
// (`plugins/env.ts`): it answers "which network does a sweep read, and where does
// it write", which is a property of the sweep and not of the queue system
// hosting it. Both read the one `services/pipeline/.env`.
//
// A `SweepScope` from the job payload overrides the environment, field by field.
// That is the split the service holds to: the environment says which atmosphere
// this deployment reads, a payload says what this one run should do differently.
// Every job in a sweep carries the same scope, so a `--dry-run` batch fans out
// into repo jobs that are also dry.
import "#/env.ts";
import type { SweepScope } from "#/queues/atproto-sync/types.ts";

export interface SyncConfig {
  databaseUrl: string;
  relayUrl: string;
  concurrency: number;
  /** Fetch + log, never write. */
  dryRun: boolean;
  /** Stop after N DIDs (0 / unset = all). */
  maxRepos: number | undefined;
  /** Sweep just this DID. */
  onlyDid: string | undefined;
  /**
   * `SYNC_PDS_URL` — enumerate DIDs from one PDS's `com.atproto.sync.listRepos`
   * instead of the relay's `listReposByCollection`. Local dev only: the atproto
   * dev-env has no relay, and its PDS answers `listReposByCollection` with
   * `AuthMissing`, so this is the only unauthenticated way to discover the
   * handful of repos living on it.
   */
  pdsListUrl: string | undefined;
  /**
   * Whether a sweep under this config observes the whole network. A partial one
   * (`onlyDid` / `maxRepos` / a single PDS) must NOT drive missing-repo
   * reconciliation: it has no basis for calling anything absent.
   */
  fullSweep: boolean;
}

const RELAY_DEFAULT = "https://relay1.us-east.bsky.network";
export const RECIPE_COLLECTION = "exchange.recipe.recipe";

function positiveInt(value: unknown, fallback: number | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function loadSyncConfig(scope: SweepScope = {}): SyncConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  const maxRepos = scope.maxRepos !== undefined ? positiveInt(scope.maxRepos, undefined) : positiveInt(process.env.SYNC_MAX_REPOS, undefined);
  const onlyDid = scope.onlyDid || process.env.SYNC_ONLY_DID || undefined;
  const pdsListUrl = process.env.SYNC_PDS_URL || undefined;

  return {
    databaseUrl,
    relayUrl: process.env.RELAY_URL ?? RELAY_DEFAULT,
    concurrency: positiveInt(process.env.SYNC_CONCURRENCY, 8) ?? 8,
    dryRun: scope.dryRun === true,
    maxRepos,
    onlyDid,
    pdsListUrl,
    fullSweep: !onlyDid && !maxRepos && !pdsListUrl,
  };
}
