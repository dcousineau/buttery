import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Job } from "bullmq";
import { runLlmEnrich } from "#/queues/recipe-enrichment/index.ts";

/**
 * The gate, end to end through the real `llm-enrich` handler: `LLM_ENRICHMENT_ENABLED=false`
 * marks the recipe `skipped` and **never constructs a provider**.
 *
 * This is the one behavior in the whole LLM half that has to be verified
 * against the database rather than a fake, because "marks the recipe skipped"
 * IS a column write — a unit test with a stubbed writer would only prove the
 * handler calls the function the test told it to call. What matters is that
 * `recipe_enrichment.llm_status` actually reads `'skipped'` afterwards, since
 * that value is what stops a backfill re-claiming the same recipes on every
 * run while the gate is off.
 *
 * `index.ts` is a Fastify plugin registering a BullMQ `Queue`/`Worker` now
 * (S3), not a `defineWorkflow` result — there is no more spec to capture and
 * dig a step out of. `runLlmEnrich` is exported from `index.ts` directly for
 * exactly this reason, and is reached the same way `atproto-sync/steps.test.ts`
 * reaches a step: build a stub `FastifyInstance` carrying only what
 * `runLlmEnrich` actually touches (`env`, `db`, `log`, `ai`, `posthog`), a fake `Job`
 * with just the members it reads (`data`, `name`, `log`, `updateProgress`),
 * and call the exported handler directly with both.
 *
 * ── HOW "NEVER CONSTRUCTS A PROVIDER" IS PROVEN ────────────────────────────
 *
 * Not by deleting env vars — `fastify.ai.resolveProvider` is a stub here that
 * THROWS if it is ever called at all. If the gate ever stopped
 * short-circuiting and the handler reached provider construction, this test
 * would fail with that throw rather than quietly passing. `fastify.posthog.fetchPrompt`
 * is stubbed the same way, since a prompt fetch is the other thing that only
 * happens once the gate has let a run through.
 *
 * No live model call and no live PostHog call happens here or anywhere in
 * this package's suites. The gate is a plain read of
 * `fastify.env.LLM_ENRICHMENT_ENABLED` — it used to be a PostHog flag
 * evaluation with an env override in front of it — so the stub supplies the
 * value directly and nothing in this file has to reach for a flag service.
 *
 * Skips (never fails) without a reachable migrated database, exactly like
 * `lib/load.db.test.ts` — see that file's header for the convention.
 */

let skipReason = "";

function announceSkip(reason: string): void {
  skipReason = reason;
  process.stderr.write(`\nSKIPPING llm-enrich gate DB test — ${reason}.\nRun it with \`pnpm --filter @buttery/pipeline test:db\` against the dev stack.\n\n`);
}

async function connectOrSkip(): Promise<Pool | null> {
  if (!process.env.DATABASE_URL) {
    announceSkip("DATABASE_URL is not set");
    return null;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await Promise.race([
      pool.query("select llm_status from recipe_enrichment limit 0"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 5s")), 5_000).unref?.()),
    ]);
    return pool;
  } catch (error) {
    announceSkip(`no reachable migrated database with the llm plan's recipe_enrichment columns (${error instanceof Error ? error.message : String(error)})`);
    await pool.end().catch(() => {});
    return null;
  }
}

const pool = await connectOrSkip();

const RUN = Date.now().toString(36).toUpperCase().padStart(10, "0").slice(-10);
const GATED_ID = `test-llm-gate-${RUN}-off`;
const GONE_ID = `test-llm-gate-${RUN}-gone`;

/** Throws if called — `llm-enrich` must not reach this on any path this suite exercises. */
function shouldNotBeCalled(what: string): () => never {
  return () => {
    throw new Error(`llm-enrich should not ${what}`);
  };
}

/** `enabled` is the gate's whole input: `runLlmEnrich` reads `fastify.env.LLM_ENRICHMENT_ENABLED` and nothing else. */
function buildStub(pool: Pool | null, enabled = "false"): FastifyInstance {
  return {
    env: { LLM_ENRICHMENT_ENABLED: enabled },
    db: pool,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ai: {
      resolveProvider: vi.fn(shouldNotBeCalled("construct a provider")),
      captureGeneration: vi.fn(),
      modelRawText: vi.fn(),
    },
    posthog: {
      client: null,
      fetchPrompt: vi.fn(shouldNotBeCalled("fetch a prompt")),
    },
  } as unknown as FastifyInstance;
}

/**
 * A fake `Job` with only what `runLlmEnrich` actually reads. `updateProgress`
 * throws rather than no-ops: this handler must not reach for it, and a silent
 * stub would let a future change start using it without anybody noticing.
 * `getChildrenValues`/`getIgnoredChildrenFailures` are omitted entirely for
 * the same reason — `llm-enrich` fans nothing out and reads no children.
 */
function fakeJob(data: unknown): Job {
  return {
    data,
    name: "llm-enrich",
    log: () => Promise.resolve(0),
    updateProgress: shouldNotBeCalled("report progress"),
  } as unknown as Job;
}

function run(fastify: FastifyInstance, payload: unknown): Promise<unknown> {
  return runLlmEnrich(fastify, fakeJob(payload));
}

let client: PoolClient;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  if (!pool) return;
  for (const key of ["LLM_ENRICHMENT_ENABLED", "LLM_ENRICHMENT_PROVIDER", "LLM_ENRICHMENT_MODEL", "OPENROUTER_API_KEY", "POSTHOG_ENABLED"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  client = await pool.connect();
  await client.query(`insert into recipe (id, origin, name) values ($1, 'local', $2)`, [GATED_ID, `Test recipe ${GATED_ID}`]);
  await client.query(`insert into recipe_enrichment (recipe_id, status, classifier_version, input_hash) values ($1, 'ok', 2, 'sha256:gate')`, [GATED_ID]);
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (!pool) return;
  await client.query(`delete from recipe where id = any($1::text[])`, [[GATED_ID, GONE_ID]]);
  client.release();
  await pool.end();
});

describe.skipIf(!pool)("llm-enrich — the fail-closed gate", () => {
  it("is exported by the queue module", () => {
    expect(runLlmEnrich, "runLlmEnrich is missing from index.ts").toBeTypeOf("function");
  });

  it("marks the recipe skipped and never constructs a provider when LLM_ENRICHMENT_ENABLED=false", async () => {
    const fastify = buildStub(pool);
    const result = await run(fastify, { recipeId: GATED_ID });
    expect(result).toEqual({ status: "skipped" });

    // The column write is the point: `skipped` is what stops a backfill
    // re-claiming this recipe on every run while the flag is off.
    const row = await client.query<{ llm_status: string | null; llm_version: number; llm_error: string | null }>(
      `select llm_status, llm_version, llm_error from recipe_enrichment where recipe_id = $1`,
      [GATED_ID],
    );
    expect(row.rows[0]?.llm_status).toBe("skipped");
    // `llm_version` is deliberately NOT stamped by a skip — that is what makes
    // "claim everything below the current version" pick these rows back up the
    // moment the flag turns on, with no `force` needed (`markLlmSkipped`'s doc).
    expect(row.rows[0]?.llm_version).toBe(0);
    // The error column belongs to real errors. A gate saying no is not one.
    expect(row.rows[0]?.llm_error).toBeNull();
  });

  it("rejects a payload with no recipeId without touching the database", async () => {
    const fastify = buildStub(pool);
    await expect(run(fastify, {})).rejects.toThrow(/recipeId/);
  });

  it("completes as `gone` for a recipe that no longer exists, rather than failing the job", async () => {
    // The gate is checked BEFORE the load, so a gated run never gets here —
    // open it for this one case to reach the load itself.
    const fastify = buildStub(pool, "true");
    // `markLlmSkipped` is not reached either: there is no row to mark, and a
    // deleted recipe is not a failure — jobs outlive rows.
    expect(await run(fastify, { recipeId: GONE_ID })).toEqual({ status: "gone" });
  });
});

if (skipReason) {
  // Keeps the file from looking like it passed when it did nothing.
  describe.skip(`llm-enrich gate DB test (skipped: ${skipReason})`, () => {});
}
