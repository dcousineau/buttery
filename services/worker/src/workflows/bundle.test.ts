import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";
import { describe, expect, it } from "vitest";

/**
 * Build the workflow bundle exactly as `worker.ts` does at boot.
 *
 * This is the test that enforces the sandbox rule (see `define.ts`): workflow
 * code runs in a deterministic isolate, so an import of `lib/` — or of `pg`, or
 * of anything reaching for `node:*` — from a `workflow.ts` fails the bundle. Out
 * of that isolate the same mistake is invisible until a workflow task fails on a
 * deployed worker.
 *
 * It runs webpack, so it is the slowest test in the package by an order of
 * magnitude. It is still worth it: this is the one class of mistake in this
 * service that types do not catch.
 */
describe("the workflow bundle", () => {
  it("builds", { timeout: 120_000 }, async () => {
    const { code } = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL("./bundle.ts", import.meta.url)),
    });

    expect(code.length).toBeGreaterThan(0);
    // A smoke check that the workflows actually made it in, rather than the
    // bundler happily producing an empty module. String literals survive
    // minification; identifiers do not.
    expect(code).toContain("AtprotoSyncFailed");
  });
});
