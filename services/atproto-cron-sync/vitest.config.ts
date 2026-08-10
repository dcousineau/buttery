import { defineConfig } from "vitest/config";

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
 *   pnpm --filter @buttery/atproto-cron-sync test:db
 *   # = railway run --service buttery -- vitest run --project db
 *
 * `railway run` is what injects `DATABASE_URL`; the dev Postgres port is
 * regenerated per machine and is never hardcoded.
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
