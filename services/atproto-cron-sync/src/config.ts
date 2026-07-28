// Environment + CLI-flag parsing for a sweep. Node runs this `.ts` directly
// (type-stripping) — keep everything erasable (no enum/namespace/param-props).

// Load a local `.env` if present (mirrors services/web/kysely.config.ts). On
// Railway, DATABASE_URL is already in the environment, so the file is absent
// and this is a no-op.
try {
  process.loadEnvFile();
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
  };
}
