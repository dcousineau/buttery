import { describe, expect, it } from "vitest";
import * as bundle from "#/workflows/bundle.ts";
import { activities } from "#/workflows/activities.ts";
import { WORKFLOWS } from "#/workflows/index.ts";

/**
 * The three lists a workflow appears in — its registration, the workflow bundle
 * and the activity barrel — have to agree, and nothing at runtime checks that
 * they do. A workflow missing from `bundle.ts` starts fine and then fails
 * "workflow type not registered" on the worker, minutes later, in a log stream.
 * Cheaper here.
 */
describe("the workflow registry", () => {
  it("exports every registered workflow from the bundle, under its registered name", () => {
    // The registration's `name` IS the workflow type a client starts, which is
    // the key the worker looks up in the bundle's namespace. A workflow missing
    // here — or exported under a differently-spelled name — starts fine and then
    // fails every workflow task with "no such function is exported by the
    // workflow bundle".
    for (const workflow of WORKFLOWS) {
      expect(typeof (bundle as Record<string, unknown>)[workflow.name]).toBe("function");
    }
  });

  it("exports nothing the registry does not know about", () => {
    expect(Object.keys(bundle).sort()).toEqual(WORKFLOWS.map((w) => w.name).sort());
  });

  it("registers unique names", () => {
    expect(new Set(WORKFLOWS.map((w) => w.name)).size).toBe(WORKFLOWS.length);
  });

  it("merges activities without collisions", () => {
    // `activities.ts` throws on a duplicate at import time; this asserts the
    // merge actually produced something, so the import above is not vacuous.
    expect(Object.keys(activities).length).toBeGreaterThan(0);
    expect(activities).toHaveProperty("indexRepoBatch");
    expect(activities).toHaveProperty("demoStep");
  });
});
