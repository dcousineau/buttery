import { Pool } from "pg";

// Single shared pg pool for the whole sweep. Lazily created so importing this
// module has no side effects. `closeDb()` MUST run before the process exits —
// an open pool keeps the event loop alive and the cron container never stops
// (Railway then skips the next scheduled run). See plan §3, the exit contract.
let pool: Pool | undefined;

export function getPool(connectionString: string): Pool {
  if (!pool) {
    pool = new Pool({ connectionString });
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
