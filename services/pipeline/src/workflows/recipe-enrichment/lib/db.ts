import { Pool } from "pg";
// Loads `services/pipeline/.env` (once, package-wide) so `DATABASE_URL` is set
// before `getPool` reads it — the same reason `atproto-sync/lib/config.ts`
// imports it, needed here too since this module reads `process.env` directly
// rather than through that workflow's `SyncConfig`.
import "#/env.ts";

// Single shared pg pool for this workflow, exactly as `atproto-sync/lib/db.ts`
// does it. Lazily created so importing this module has no side effects, and
// kept between runs: a worker replica classifies recipes across many jobs, so
// re-establishing a connection per job would be pure waste.
//
// `closeDb()` is what lets a process actually exit — an open pool keeps the
// event loop alive forever. The workflow declares it as its `close`, which the
// worker calls once every in-flight job has drained (`worker.ts`), and the
// one-shot CLI calls before it returns (`run-once.ts`).
let pool: Pool | undefined;

/**
 * Get the shared pool, reading `DATABASE_URL` from the environment on first
 * use. Unlike `atproto-sync/lib/db.ts`'s `getPool`, this takes no argument:
 * that workflow threads a per-run `SyncConfig` (scope can override the
 * database it targets); this one has no such scope, so there is nothing to
 * thread through and reading `process.env` directly here is simpler than
 * inventing a config object with one field.
 */
export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
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
