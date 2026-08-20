// Environment parsing for a sweep. Node runs this `.ts` directly
// (type-stripping) — keep everything erasable (no enum/namespace/param-props).
//
// This is the workflow's own configuration, separate from the service's
// (`#/config.ts`): it answers "which network does a sweep read, and where does
// it write", which is a property of the sweep and not of the queue system
// hosting it. Both read the one `services/pipeline/.env`.
import "#/env.ts";

export interface SyncConfig {
  databaseUrl: string;
  relayUrl: string;
  concurrency: number;
  /** Fetch + log, never write. Comes from the job payload, not the environment. */
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
   * handful of repos living on it. Treated as a partial sweep (see steps.ts).
   */
  pdsListUrl: string | undefined;
}

const RELAY_DEFAULT = "https://relay1.us-east.bsky.network";
export const RECIPE_COLLECTION = "exchange.recipe.recipe";

export function loadSyncConfig(): SyncConfig {
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
    // Overridden per run from the job payload; see `start()` in index.ts.
    dryRun: false,
    maxRepos,
    onlyDid: process.env.SYNC_ONLY_DID || undefined,
    pdsListUrl: process.env.SYNC_PDS_URL || undefined,
  };
}
