import { defineConfig } from "vitest/config";

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
 * Run just the integration suites against the local dev stack:
 *
 *   pnpm test:db          # = railway run --service buttery -- vitest run --project db
 *
 * `railway run` is what injects `DATABASE_URL` (and the rest of the service
 * env) — the dev Postgres port is regenerated per machine, so it is never
 * hardcoded here or anywhere else.
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
