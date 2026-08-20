import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";
import { describe, expect, it } from "vitest";
import { createActivities } from "#/activities.ts";
import * as workflows from "#/workflows.ts";

/**
 * The two things about this service that types do not catch.
 */
describe("the workflow bundle", () => {
  it("builds the way the worker builds it at boot", { timeout: 120_000 }, async () => {
    // This is what enforces the sandbox rule: workflow code runs in a
    // deterministic isolate, so an import of `lib/` — or of `pg`, or of anything
    // reaching for `node:*` — from a `workflow.ts` fails the bundle here rather
    // than on a deployed worker, minutes later, in a log stream.
    const { code } = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    });

    expect(code.length).toBeGreaterThan(0);
    // String literals survive minification; identifiers do not.
    expect(code).toContain("AtprotoSyncFailed");
  });

  it("exports each workflow as a function, under the name it is started by", () => {
    // The export name IS the workflow type — `--type atprotoSync`. A workflow
    // that is renamed here and nowhere else starts fine and then fails every
    // workflow task with "no such function is exported by the workflow bundle".
    expect(Object.keys(workflows).sort()).toEqual(["atprotoSync", "demo"]);
    for (const workflow of Object.values(workflows)) {
      expect(typeof workflow).toBe("function");
    }
  });
});

describe("the activity registry", () => {
  it("exposes every activity the workflows proxy", () => {
    // Activity names are a namespace shared across the whole worker: two
    // workflows exporting the same name would silently register one
    // implementation for both.
    const activities = createActivities({ pool: {} as never });
    expect(Object.keys(activities).sort()).toEqual(["closeSyncRun", "demoStep", "enumerateRepos", "openSyncRun", "reconcileMissingRepos", "syncRepo"]);
  });
});
