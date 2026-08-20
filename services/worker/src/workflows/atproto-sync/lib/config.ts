// Which network a sweep reads. Node runs this `.ts` directly (type-stripping) —
// keep everything erasable (no enum/namespace/parameter properties).
//
// Read inside activities, never inside workflow code: a workflow that read
// `process.env` would be non-deterministic — its replay on another worker could
// see a different value and take a different path — so every environment lookup
// lives on this side of the activity boundary.
//
// The environment describes the deployment ("which atmosphere does this worker
// read"); a `SweepScope` argument describes one run. The argument wins where it
// is set, which is what makes a scoped or dry sweep something you ask for at
// start time rather than something you redeploy for.
import "#/env.ts";
import type { SweepScope } from "#/workflows/atproto-sync/types.ts";

export interface SyncConfig {
  relayUrl: string;
  dryRun: boolean;
  maxRepos: number | undefined;
  onlyDid: string | undefined;
  /**
   * `SYNC_PDS_URL` — enumerate DIDs from one PDS's `com.atproto.sync.listRepos`
   * instead of the relay's `listReposByCollection`. Local dev only: the atproto
   * dev-env has no relay, and its PDS answers `listReposByCollection` with
   * `AuthMissing`, so this is the only unauthenticated way to discover the
   * handful of repos living on it.
   */
  pdsListUrl: string | undefined;
  /** Whether this sweep will observe the whole network. See `EnumerateResult`. */
  fullSweep: boolean;
}

const RELAY_DEFAULT = "https://relay1.us-east.bsky.network";
export const RECIPE_COLLECTION = "exchange.recipe.recipe";

function positiveInt(raw: string | number | undefined): number | undefined {
  const parsed = Number(raw ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export function loadSyncConfig(scope: SweepScope = {}): SyncConfig {
  const maxRepos = positiveInt(scope.maxRepos ?? process.env.SYNC_MAX_REPOS);
  const onlyDid = scope.onlyDid ?? process.env.SYNC_ONLY_DID ?? undefined;
  const pdsListUrl = process.env.SYNC_PDS_URL || undefined;

  return {
    relayUrl: process.env.RELAY_URL ?? RELAY_DEFAULT,
    dryRun: scope.dryRun === true,
    maxRepos,
    onlyDid: onlyDid || undefined,
    pdsListUrl,
    fullSweep: !onlyDid && !maxRepos && !pdsListUrl,
  };
}
