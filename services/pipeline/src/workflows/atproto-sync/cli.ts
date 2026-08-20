import { closeDb } from "#/workflows/atproto-sync/db.ts";
import { loadSyncConfig } from "#/workflows/atproto-sync/config.ts";
import { log } from "#/log.ts";
import { runSweep } from "#/workflows/atproto-sync/sweep.ts";

// One sweep, then exit — `pnpm --filter @buttery/pipeline sync:once`.
//
// The same code the scheduled workflow runs, driven from a shell instead of
// from a queue, and reading the same `services/pipeline/.env`. It stays because
// iterating on the sweep through Redis and a worker is a slow way to work, and
// because a one-off backfill (`SYNC_MAX_REPOS=25`, `SYNC_ONLY_DID=…`) should not
// require the dev stack to be up.
//
// `--once` is accepted for symmetry with the old cron start command but is a
// no-op: one sweep per invocation is the only mode. `--dry-run` fetches and logs
// without writing.

async function main(): Promise<void> {
  const config = { ...loadSyncConfig(), dryRun: process.argv.includes("--dry-run") };
  try {
    const summary = await runSweep(config);
    log.info("sweep complete", { ...summary });
    process.exitCode = summary.status === "ok" ? 0 : 1;
  } catch (err) {
    log.error("sweep failed", { err: String(err) });
    process.exitCode = 1;
  } finally {
    await closeDb(); // MUST end the pool or the process never exits
  }
}

await main();
