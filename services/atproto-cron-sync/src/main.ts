import { loadConfig } from "#/config.ts";
import { closeDb } from "#/db.ts";
import { log } from "#/log.ts";
import { runSweep } from "#/sweep.ts";

// Entrypoint: parse args, run one sweep, exit. The exit contract is
// load-bearing — Railway skips the next scheduled run while this deployment is
// still Active, so we MUST end the pg pool (`closeDb`) and let the process exit
// naturally with nothing keeping the event loop alive (plan §3).
//
// `--once` is accepted for symmetry with the cron start command but is a no-op:
// one sweep per invocation is the only mode. `--dry-run` fetches and logs
// without writing.

async function main(): Promise<void> {
  const config = loadConfig(process.argv.slice(2));
  try {
    const summary = await runSweep(config);
    log.info("sweep complete", { ...summary });
    process.exitCode = summary.status === "ok" ? 0 : 1;
  } catch (err) {
    log.error("sweep failed", { err: String(err) });
    process.exitCode = 1; // non-zero so Railway marks the cron run failed
  } finally {
    await closeDb(); // MUST end the pool or the process never exits
  }
}

await main();
