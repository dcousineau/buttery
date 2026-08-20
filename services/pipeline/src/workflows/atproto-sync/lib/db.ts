import { Pool } from "pg";

// Single shared pg pool for the sweep. Lazily created so importing this module
// has no side effects, and kept between runs: a worker replica sweeps on a
// schedule, so re-establishing connections every hour would be pure waste.
//
// `closeDb()` is what lets a process actually exit — an open pool keeps the
// event loop alive forever. The workflow declares it as its `close`, which the
// worker calls once every in-flight job has drained (`worker.ts`), and the
// one-shot CLI calls before it returns (`run-once.ts`).
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
