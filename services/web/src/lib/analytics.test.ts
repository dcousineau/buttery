import { describe, expect, it } from "vitest";
import { createNoopPostHog } from "./analytics";

/**
 * The stand-in the app holds outside production. It has to survive being used as
 * if it were the real client — including the shapes nobody writes on purpose,
 * like awaiting it or logging it.
 */
/** The stand-in accepts anything, which posthog-js's real types do not describe. */
type Chainable = ((...args: unknown[]) => Chainable) & { [key: string]: Chainable };

describe("no-op PostHog", () => {
  it("no-ops any method, however deeply chained", () => {
    const posthog = createNoopPostHog();
    const loose = posthog as unknown as Chainable;

    expect(() => {
      posthog.capture("recipe_created", { imported: true });
      posthog.identify("did:plc:local", { handle: "chef.test" });
      posthog.reset();
      // Nothing calls this — the point is that an API we never anticipated,
      // chained arbitrarily deep, still cannot throw.
      loose.group("household", "h_1").people.set({ plan: "free" });
    }).not.toThrow();
  });

  it("returns itself from a call, so chaining keeps working", () => {
    const loose = createNoopPostHog() as unknown as Chainable;

    expect(loose.capture("x")).toBe(loose.setPersonProperties({}));
  });

  it("reports feature flags as unknown, never as enabled", () => {
    const posthog = createNoopPostHog();

    // The whole reason this is not a bare chaining proxy: every object is truthy,
    // so a chainable stand-in here would read as ENABLED and fail open.
    expect(posthog.isFeatureEnabled("atproto-publishing-enabled")).toBeUndefined();
    expect(posthog.getFeatureFlag("invited")).toBeUndefined();
    expect(posthog.getFeatureFlagPayload("invited")).toBeUndefined();
    expect(posthog.has_opted_in_capturing()).toBeUndefined();
  });

  it("reports the support widget as absent, so its poll loops never start", () => {
    const posthog = createNoopPostHog();

    expect(posthog.conversations).toBeUndefined();
  });

  it("is not a thenable — awaiting it must not hang", async () => {
    const posthog = createNoopPostHog();

    expect((posthog as unknown as { then?: unknown }).then).toBeUndefined();
    await expect(Promise.resolve(posthog)).resolves.toBe(posthog);
  });

  it("coerces to a string instead of throwing", () => {
    const posthog = createNoopPostHog();

    expect(`${posthog}`).toBe("[posthog disabled]");
  });
});
