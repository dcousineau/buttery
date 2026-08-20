import { defineConfig } from "vitest/config";

/**
 * Unit tests only. Everything here is a pure function — the scaling policy, the
 * backlog arithmetic, payload parsing — so nothing needs a Redis, and `pnpm
 * test` stays green on a fresh clone with nothing running.
 *
 * Tests import through the `#/*` subpath imports declared in `package.json`,
 * which Vite resolves natively — the same arrangement the other packages use.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
