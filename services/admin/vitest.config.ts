import { defineConfig } from "vitest/config";

/**
 * Pure-logic tests only, and node-environment only. The admin has no
 * component-level behaviour worth a DOM (its pages are tables over server data)
 * and no DB-backed suite (the queries it runs are read-only and covered by the
 * app's own schema tests). What is worth testing is the projection and
 * comparison logic in `lib/record-shape.ts` and `server/json.ts`: it is where a
 * silent bug shows up as two identical records reported as differing, which is
 * exactly the kind of wrong answer this tool must not give.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
