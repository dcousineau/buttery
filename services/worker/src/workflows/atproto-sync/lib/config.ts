// Which network a sweep reads, and where it writes. Node runs this `.ts`
// directly (type-stripping) — keep everything erasable (no enum/namespace/
// parameter properties).
//
// This is the *workflow's* configuration, separate from the service's
// (`#/config.ts`): "which atmosphere gets swept" is a property of the sweep,
// not of the Temporal worker hosting it. Both read the one
// `services/worker/.env`.
//
// Read inside activities, never inside workflow code. A workflow that read
// `process.env` would be non-deterministic — its replay on another replica
// could see a different value and take a different path — so every environment
// lookup lives on this side of the activity boundary.
import "#/env.ts";

export interface SyncConfig {
  databaseUrl: string;
  relayUrl: string;
  concurrency: number;
  /**
   * Fetch + log, never write. Comes from the workflow's input rather than the
   * environment: it is per-run, and the whole point of a dry run is asking for
   * one without redeploying anything.
   */
  dryRun: boolean;
  /** `SYNC_MAX_REPOS` — stop after N DIDs (0 / unset = all). */
  maxRepos: number | undefined;
  /** `SYNC_ONLY_DID` — sync just this DID. */
  onlyDid: string | undefined;
  /**
   * `SYNC_PDS_URL` — enumerate DIDs from one PDS's `com.atproto.sync.listRepos`
   * instead of the relay's `listReposByCollection`. Local dev only: the atproto
   * dev-env has no relay, and its PDS answers `listReposByCollection` with
   * `AuthMissing`, so this is the only unauthenticated way to discover the
   * handful of repos living on it. Treated as a partial sweep (see workflow.ts).
   */
  pdsListUrl: string | undefined;
}

const RELAY_DEFAULT = "https://relay1.us-east.bsky.network";
export const RECIPE_COLLECTION = "exchange.recipe.recipe";

export function loadSyncConfig(dryRun = false): SyncConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  const maxReposRaw = Number(process.env.SYNC_MAX_REPOS ?? 0);
  const maxRepos = Number.isFinite(maxReposRaw) && maxReposRaw > 0 ? Math.floor(maxReposRaw) : undefined;

  const concurrencyRaw = Number(process.env.SYNC_CONCURRENCY ?? 8);
  const concurrency = Number.isFinite(concurrencyRaw) && concurrencyRaw > 0 ? Math.floor(concurrencyRaw) : 8;

  return {
    databaseUrl,
    relayUrl: process.env.RELAY_URL ?? RELAY_DEFAULT,
    concurrency,
    dryRun,
    maxRepos,
    onlyDid: process.env.SYNC_ONLY_DID || undefined,
    pdsListUrl: process.env.SYNC_PDS_URL || undefined,
  };
}

/**
 * Whether a sweep run under this config observed the whole network. A partial
 * one (`SYNC_ONLY_DID` / `SYNC_MAX_REPOS` / `SYNC_PDS_URL`) must NOT drive
 * missing-repo reconciliation: it has no basis for calling anything absent.
 */
export function isFullSweep(config: SyncConfig): boolean {
  return !config.onlyDid && !config.maxRepos && !config.pdsListUrl;
}
