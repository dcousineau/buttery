import { defineConfig } from "vitest/config";

// The `db` suites need DATABASE_URL, and nothing wraps the run to inject it —
// load this package's `.env` here, in the config, so `pnpm test:db` is a bare
// `vitest run`. Same arrangement as `services/pipeline/vitest.config.ts`.
// Vitest workers inherit this process's env. Vite may load this config from a
// temp file, so the path is cwd-based (the package dir, which is what
// `pnpm --filter` runs in) rather than relative to import.meta.url.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env file present — the db suites skip themselves without DATABASE_URL.
}

/**
 * Two vitest projects, split by what a test needs to exist.
 *
 * - `unit` — every `*.test.ts` that is a pure function test. No database, no
 *   network, no environment. This is the suite that must stay green on a fresh
 *   clone with nothing running.
 * - `db` — the `*.db.test.ts` integration suites. They talk to a real Postgres
 *   with the migrations applied and they SKIP (never fail) when there isn't
 *   one, so `pnpm test` is still green on a machine with no database.
 *
 * Run just the integration suites against the local dev stack (start it first
 * with `pnpm dev`, or `docker compose up -d postgres` for the database alone):
 *
 *   pnpm test:db          # = vitest run --project db
 *
 * `DATABASE_URL` comes from the `.env` beside this file, loaded above: it
 * points at the repo-owned Postgres on the fixed port in the root
 * `docker-compose.yml`. Nothing else injects it.
 *
 * Deliberately a separate file from `vite.config.ts`: the app config carries
 * the TanStack Start / React / Tailwind plugins, none of which any test needs,
 * and editing the app config to add test settings restarts the dev server.
 * Tests import through the `#/*` subpath imports declared in `package.json`,
 * which Vite resolves natively.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: ["src/**/*.db.test.{ts,tsx}"],
        },
      },
      {
        test: {
          name: "db",
          include: ["src/**/*.db.test.{ts,tsx}"],
          // The DB suites share one dev database. Serial files keep two suites
          // from cleaning up each other's scratch rows, and the harness is
          // fast enough that parallelism buys nothing.
          fileParallelism: false,
          // Real connections, real transactions, real lock waits.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
