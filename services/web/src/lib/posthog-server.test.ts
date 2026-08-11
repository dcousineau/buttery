import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The production-only gate on the server half of PostHog.
 *
 * These assert the thing the gate exists for: outside production, nothing
 * reaches the network. `railway run` injects the real production project token
 * into local shells (including this test run), so every case here keeps
 * `POSTHOG_PROJECT_TOKEN` set — a token must not be enough on its own.
 *
 * `posthog-server` memoizes its client for the process, so each case resets the
 * module registry and re-imports it under fresh env.
 */

const TOKEN = "phc_test_token";

async function loadModule(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import("./posthog-server");
}

let fetchSpy: ReturnType<typeof vi.fn>;
const savedEnv = { ...process.env };

beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ status: 1 }), { status: 200, headers: { "content-type": "application/json" } })));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...savedEnv };
});

describe("posthog-server gate", () => {
  // The exact value that turns PostHog on is the string "true" and nothing else.
  for (const enabled of [undefined, "", "false", "TRUE", "1", "yes", "production"]) {
    it(`writes nothing when POSTHOG_ENABLED is ${JSON.stringify(enabled)}`, async () => {
      const { identify } = await loadModule({ POSTHOG_ENABLED: enabled, POSTHOG_PROJECT_TOKEN: TOKEN });

      await identify("did:plc:local-dev", { handle: "chef.test" });

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it("evaluates no flags when disabled — evaluation itself captures $feature_flag_called", async () => {
    const { isAtprotoPublishEnabled } = await loadModule({
      POSTHOG_ENABLED: undefined,
      POSTHOG_PROJECT_TOKEN: TOKEN,
      ATPROTO_PUBLISH_ENABLED: undefined,
    });

    // Fail-closed: no client to ask, so the kill switch stays shut.
    await expect(isAtprotoPublishEnabled("did:plc:local-dev")).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the ATPROTO_PUBLISH_ENABLED override working while disabled", async () => {
    const { isAtprotoPublishEnabled } = await loadModule({
      POSTHOG_ENABLED: undefined,
      POSTHOG_PROJECT_TOKEN: TOKEN,
      ATPROTO_PUBLISH_ENABLED: "true",
    });

    await expect(isAtprotoPublishEnabled("did:plc:local-dev")).resolves.toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still writes when enabled, so the gate has not simply broken production", async () => {
    const { identify } = await loadModule({ POSTHOG_ENABLED: "true", POSTHOG_PROJECT_TOKEN: TOKEN });

    await identify("did:plc:someone", { handle: "chef.example" });

    // flushAt: 1 — the identify is flushed rather than batched.
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
  });
});
