import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "#/app.ts";

/**
 * `buildApp`'s two `@fastify/autoload` calls, proven end to end.
 *
 * A green `tsc --noEmit` only proves the autoload options are well-typed — it
 * says nothing about whether autoload actually found `src/workflows/`'s three
 * workflow plugins, or whether `app.ts`'s `matchFilter` really keeps `lib/`
 * modules and test files out of the plugin tree. Both failure modes are
 * silent: an autoload that matches nothing produces an app with no workflows
 * and no error. So this suite builds the real app against `src/plugins/` and
 * `src/workflows/` on disk and asserts what landed in the registry.
 *
 * `recipe-enrichment/index.llm.db.test.ts` is what it guards against most
 * directly: without the `matchFilter`, autoload recurses into a workflow
 * directory, finds no `index.ts` at the level it is walking, and treats every
 * sibling script — that suite included — as its own plugin candidate.
 *
 * ── Why this is a unit test, despite building the whole app ────────────────
 * It is in the `unit` project, not `db`, because it needs nothing running:
 * ioredis does not block construction on an unreachable host, BullMQ's `Queue`
 * reuses the shared client through `connection` rather than opening its own,
 * and pg's `Pool` connects lazily. The env below is therefore stubbed to
 * syntactically valid but deliberately unreachable URLs rather than read from
 * `.env` — `plugins/env.ts` requires both variables to exist, and stubbing
 * them is what keeps this green on a fresh clone with nothing running.
 *
 * Pointing at port 1 on purpose: if some future plugin starts connecting at
 * boot, this suite fails on a timeout rather than quietly passing against
 * whatever the developer happened to have running.
 */

let app: FastifyInstance;

beforeAll(async () => {
  vi.stubEnv("REDIS_URL", "redis://127.0.0.1:1");
  vi.stubEnv("DATABASE_URL", "postgres://pipeline:pipeline@127.0.0.1:1/none");
  // "cli" so `plugins/workflow.ts`'s `onReady` takes neither the worker branch
  // (which would build real `Worker`s and start fetching) nor the server one
  // (which would reconcile schedules against Redis).
  app = await buildApp("cli");
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
});

describe("buildApp", () => {
  it("registers exactly the three workflow plugins — nothing from lib/, no test file", () => {
    const names = app.workflows.list().map((registration) => registration.spec.name);
    expect(names.slice().sort()).toEqual(["atproto-sync", "demo", "recipe-enrichment"]);
  });

  it("workflows.get and workflows.list agree, and an unknown name is undefined", () => {
    for (const registration of app.workflows.list()) {
      expect(app.workflows.get(registration.spec.name)).toBe(registration);
    }
    expect(app.workflows.get("not-a-real-workflow")).toBeUndefined();
  });

  it("each registration carries a real queue and kernel workflow, not a stub", () => {
    for (const registration of app.workflows.list()) {
      expect(typeof registration.queue.add).toBe("function");
      expect(typeof registration.workflow.run).toBe("function");
    }
  });
});
