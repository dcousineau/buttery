import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { DB } from "#/db/types";

// Server-only module: reads DATABASE_URL from the process environment.
// On Railway this is injected from the postgres service (see .railway/railway.ts);
// locally `railway dev` injects it, or set it in .env (see .env.example).
//
// This is the single shared Postgres entry point for the app. Everything that
// touches the database goes through the Kysely instance from `getDb()` —
// including better-auth, which uses Kysely internally and is handed this same
// instance in `auth.ts`. Both the Pool and the Kysely instance are lazily
// created singletons so a serverless/SSR request reuses one connection pool.
let pool: Pool | undefined;
let db: Kysely<DB> | undefined;

/** Raw `pg` connection pool. Prefer `getDb()`; use this only for cases Kysely
 * can't express (LISTEN/NOTIFY, COPY, etc.). */
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

/** Shared, typed Kysely instance — the primary way to query Postgres. */
export function getDb(): Kysely<DB> {
  if (!db) {
    db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: getPool() }),
    });
  }
  return db;
}
