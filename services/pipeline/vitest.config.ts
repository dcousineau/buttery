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
 * - `unit` — pure function tests: the scaling policy, the backlog arithmetic,
 *   the step runner, the sweep's rendering. No database, no network, no Redis,
 *   so `pnpm test` stays green on a fresh clone with nothing running.
 * - `db` — `*.db.test.ts` integration suites against a real migrated Postgres.
 *   They SKIP (never fail) when there isn't one.
 *
 *   pnpm --filter @buttery/pipeline test:db   # = vitest run --project db
 *
 * Tests import through the `#/*` subpath imports declared in `package.json`,
 * which Vite resolves natively — the same arrangement the other packages use.
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
