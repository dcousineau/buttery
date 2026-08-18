// Environment + CLI-flag parsing for a sweep. Node runs this `.ts` directly
// (type-stripping) — keep everything erasable (no enum/namespace/param-props).

// Local dev config comes from this package's `.env` (see `.env.example`) —
// there is no `railway run` wrapper injecting it. Resolved relative to this
// file, not the cwd, so a run from the repo root behaves the same; note
// `process.loadEnvFile()` does NOT walk up looking for a `.env`. Absent on
// Railway, where the platform's environment stands alone — and an already-set
// var always wins, since loadEnvFile never overwrites one.
try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // No .env file present — rely on the ambient environment.
}

export interface Config {
  databaseUrl: string;
  relayUrl: string;
  concurrency: number;
  /** `--dry-run`: fetch + log, never write. */
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
   * handful of repos living on it. Treated as a partial sweep (see sweep.ts).
   */
  pdsListUrl: string | undefined;
}

const RELAY_DEFAULT = "https://relay1.us-east.bsky.network";
export const RECIPE_COLLECTION = "exchange.recipe.recipe";

export function loadConfig(argv: string[]): Config {
  const flags = new Set(argv);

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
    dryRun: flags.has("--dry-run"),
    maxRepos,
    onlyDid: process.env.SYNC_ONLY_DID || undefined,
    pdsListUrl: process.env.SYNC_PDS_URL || undefined,
  };
}
