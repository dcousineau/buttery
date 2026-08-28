import { describe, expect, it } from "vitest";
import type { AutoscaleConfig } from "#/config.ts";
import { decideReplicas } from "#/lib/railway/autoscale.ts";

const config: AutoscaleConfig = {
  apiToken: "test",
  projectId: "proj",
  environmentId: "env",
  targetServiceName: "pipeline-worker",
  targetServiceId: undefined,
  minReplicas: 1,
  maxReplicas: 5,
  backlogPerReplica: 25,
  intervalMs: 60_000,
  scaleDownCooldownMs: 300_000,
  dryRun: false,
};

const NOW = 1_000_000;

describe("decideReplicas", () => {
  it("holds at the floor when the queues are empty", () => {
    const decision = decideReplicas(config, { pending: 0, current: 1, now: NOW, lastScaleDownAt: undefined });
    expect(decision.changed).toBe(false);
    expect(decision.desired).toBe(1);
  });

  it("never drops below minReplicas", () => {
    const decision = decideReplicas({ ...config, minReplicas: 2 }, { pending: 0, current: 2, now: NOW, lastScaleDownAt: undefined });
    expect(decision.desired).toBe(2);
  });

  it("rounds up so a partial batch still gets a replica", () => {
    // 26 pending at 25/replica is two replicas' worth, not 1.04.
    const decision = decideReplicas(config, { pending: 26, current: 1, now: NOW, lastScaleDownAt: undefined });
    expect(decision).toMatchObject({ desired: 2, changed: true });
  });

  it("scales up immediately, without waiting out a cooldown", () => {
    const decision = decideReplicas(config, { pending: 100, current: 1, now: NOW, lastScaleDownAt: NOW - 1 });
    expect(decision).toMatchObject({ desired: 4, changed: true });
  });

  it("clamps to maxReplicas however deep the backlog is", () => {
    const decision = decideReplicas(config, { pending: 100_000, current: 1, now: NOW, lastScaleDownAt: undefined });
    expect(decision.desired).toBe(config.maxReplicas);
  });

  it("holds a scale-down until the cooldown has elapsed", () => {
    const decision = decideReplicas(config, {
      pending: 0,
      current: 4,
      now: NOW,
      lastScaleDownAt: NOW - 60_000, // 1 min into a 5 min cooldown
    });
    expect(decision.changed).toBe(false);
    expect(decision.desired).toBe(4);
    expect(decision.reason).toContain("cooldown");
  });

  it("scales down once the cooldown has elapsed", () => {
    const decision = decideReplicas(config, {
      pending: 0,
      current: 4,
      now: NOW,
      lastScaleDownAt: NOW - 600_000,
    });
    expect(decision).toMatchObject({ desired: 1, changed: true });
  });

  it("scales down on the first opportunity when nothing has scaled down yet", () => {
    const decision = decideReplicas(config, { pending: 0, current: 3, now: NOW, lastScaleDownAt: undefined });
    expect(decision).toMatchObject({ desired: 1, changed: true });
  });

  it("treats active jobs as load, so a saturated fleet does not scale down", () => {
    // 4 replicas each chewing through 25 in-flight jobs: pending == capacity,
    // so the decision must be "hold", not "shrink".
    const decision = decideReplicas(config, { pending: 100, current: 4, now: NOW, lastScaleDownAt: undefined });
    expect(decision.changed).toBe(false);
  });
});
