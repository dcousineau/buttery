import { Pool } from "pg";
import { loadSyncConfig } from "#/workflows/atproto-sync/lib/config.ts";

// Single shared pg pool for the sweep's activities. Lazily created so importing
// this module has no side effects, and kept between runs: a worker replica
// sweeps on a schedule, so re-establishing connections every hour would be pure
// waste.
//
// `closeDb()` is what lets the process actually exit — an open pool keeps the
// event loop alive forever. The worker calls it on shutdown once activities have
// drained, and `run-once.ts` calls it before it returns.
let pool: Pool | undefined;

export function getPool(connectionString?: string): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: connectionString ?? loadSyncConfig().databaseUrl });
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
