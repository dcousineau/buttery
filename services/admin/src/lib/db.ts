import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { DB } from "#/db/types";

/**
 * Server-only module: the admin's single Postgres entry point.
 *
 * **Same database as the app, on purpose.** The admin exists to read the real
 * `public` tables — `recipe`, `atproto_collection_recipe`, `household` — so it
 * connects to the same `DATABASE_URL` `services/web` does. What it does *not*
 * share is identity: everything the admin owns lives in the `admin` schema
 * (migrations `*_admin_*` in `services/web/src/db/migrations`).
 *
 * **`search_path = admin, public`.** better-auth's Kysely adapter emits
 * unqualified table names and gives us no hook to schema-qualify them, so the
 * search path is what puts its writes in the right schema. The admin tables are
 * named `admin_user` / `admin_session` / … rather than `user` / `session` so
 * nothing in `admin` shadows a `public` table of the same name — an unqualified
 * `user` resolving to two different tables depending on which pool ran the
 * query is the failure this naming makes impossible.
 *
 * `options` is applied by libpq/`pg` at connection setup, so every connection
 * this pool hands out has the path already set — including ones created later
 * to replace a dropped client.
 *
 * The pool and the Kysely instance are lazily created singletons, so an
 * SSR request reuses one connection pool.
 */
let pool: Pool | undefined;
let db: Kysely<DB> | undefined;

/** Raw `pg` pool. Prefer `getDb()`. */
export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    pool = new Pool({
      connectionString,
      options: "-c search_path=admin,public",
      // The admin is a single-operator internal tool sharing a database with
      // the app. It has no business holding ten connections the app might want.
      max: 4,
    });
    // A `pg` Pool with no `error` listener re-throws errors from IDLE clients
    // as an unhandled 'error' event, which takes the whole process down. Same
    // hazard, same handling as `services/web/src/lib/db.ts`.
    pool.on("error", (error) => {
      console.error("[admin/db] idle client error (pool will reconnect):", error);
    });
  }
  return pool;
}

/** Shared, typed Kysely instance — the primary way the admin queries Postgres. */
export function getDb(): Kysely<DB> {
  if (!db) {
    db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: getPool() }) });
  }
  return db;
}
