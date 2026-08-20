import { defineConfig } from "vitest/config";

// The `db` suites need DATABASE_URL, and nothing wraps the run to inject it —
// load this package's `.env` here, in the config, so `pnpm test:db` is a bare
// `vitest run`. Vitest workers inherit this process's env. Vite may load this
// config from a temp file, so the path is cwd-based (the package dir, which is
// what `pnpm --filter` runs in) rather than relative to import.meta.url.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env file present — the db suites skip themselves without DATABASE_URL.
}

/**
 * Two vitest projects, split by what a test needs to exist — the same split as
 * `services/web/vitest.config.ts`, for the same reason.
 *
 * - `unit` — pure function tests. No database, no network. Green on a fresh
 *   clone with nothing running.
 * - `db` — `*.db.test.ts` integration suites against a real migrated Postgres.
 *   They SKIP (never fail) when there isn't one, so `pnpm test` stays green on
 *   a machine that has never booted the dev stack.
 *
 *   pnpm --filter @buttery/worker test:db   # = vitest run --project db
 *
 * `DATABASE_URL` comes from `services/worker/.env` (loaded above), which points at
 * the docker-compose Postgres the `pnpm dev` stack runs — so the stack has to
 * be up, but no `railway run` wrapper is involved.
 *
 * Tests import through the `#/*` subpath imports declared in `package.json`,
 * which Vite resolves natively — the same arrangement the web package uses.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.db.test.ts"],
        },
      },
      {
        test: {
          name: "db",
          include: ["src/**/*.db.test.ts"],
          // One shared dev database; serial files keep two suites from cleaning
          // up each other's scratch rows.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
