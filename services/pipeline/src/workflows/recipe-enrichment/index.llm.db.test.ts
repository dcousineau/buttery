import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { LLM_ENRICH_STEP } from "@buttery/pipeline-contract";
import type { StepContext, StepSpec, WorkflowSpec } from "#/plugins/workflow.ts";
import recipeEnrichmentPlugin from "#/workflows/recipe-enrichment/index.ts";

/**
 * The gate, end to end through the real `llm-enrich` step: `LLM_ENRICHMENT_ENABLED=false`
 * marks the recipe `skipped` and **never constructs a provider**.
 *
 * This is the one behavior in the whole LLM half that has to be verified
 * against the database rather than a fake, because "marks the recipe skipped"
 * IS a column write — a unit test with a stubbed writer would only prove the
 * step calls the function the test told it to call. What matters is that
 * `recipe_enrichment.llm_status` actually reads `'skipped'` afterwards, since
 * that value is what stops a backfill re-claiming the same recipes on every
 * run while the flag is off.
 *
 * `index.ts` is a Fastify plugin now (S3), not a `defineWorkflow` result with
 * its own `.run(...)` — there is no more standalone `recipeEnrichment` export
 * to import and drive. Reached the same way `atproto-sync/steps.test.ts`
 * reaches a step: build a stub Fastify instance carrying only what
 * `llm-enrich` actually touches (`db`, `log`, `ai`, `posthog`, `env`, and a
 * `workflow` decorator that just records the spec it was handed), invoke the
 * plugin function directly to register that spec, then call the `llm-enrich`
 * `StepSpec.run` found on it with a hand-built `StepContext`.
 *
 * ── HOW "NEVER CONSTRUCTS A PROVIDER" IS PROVEN ────────────────────────────
 *
 * Not by deleting env vars — `fastify.ai.resolveProvider` is a stub here that
 * THROWS if it is ever called at all. If the gate ever stopped
 * short-circuiting and the step reached provider construction, this test
 * would fail with that throw rather than quietly passing. `fastify.posthog.fetchPrompt`
 * is stubbed the same way, since a prompt fetch is the other thing that only
 * happens once the gate has let a run through.
 *
 * No live model call and no live PostHog call happens here or anywhere in
 * this package's suites — the env override is checked BEFORE the flag
 * precisely so that this path needs neither.
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

let capturedSpec: WorkflowSpec | undefined;

function buildStub(pool: Pool | null): FastifyInstance {
  return {
    db: pool,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    env: { RECIPE_ENRICHMENT_MAX_IN_FLIGHT: undefined },
    ai: {
      resolveProvider: vi.fn(shouldNotBeCalled("construct a provider")),
      captureGeneration: vi.fn(),
      modelRawText: vi.fn(),
    },
    posthog: {
      client: null,
      fetchPrompt: vi.fn(shouldNotBeCalled("fetch a prompt")),
    },
    workflow: (spec: WorkflowSpec) => {
      capturedSpec = spec;
    },
  } as unknown as FastifyInstance;
}

recipeEnrichmentPlugin(buildStub(pool));

const llmEnrichStep: StepSpec | undefined = capturedSpec?.steps.find((step) => step.name === LLM_ENRICH_STEP);

/**
 * A `StepContext` with only what `llm-enrich` actually reads. `progress`,
 * `children`, `flow`, `enqueue` throw rather than no-op: this step must not
 * reach for any of them, and a silent stub would let a future change start
 * using one without anybody noticing.
 */
function context(payload: unknown): StepContext {
  return {
    payload,
    runId: "test",
    log: () => Promise.resolve(),
    progress: shouldNotBeCalled("report progress"),
    children: shouldNotBeCalled("read children"),
    flow: shouldNotBeCalled("fan out"),
    enqueue: shouldNotBeCalled("enqueue anything"),
  };
}

function run(payload: unknown): Promise<unknown> {
  if (!llmEnrichStep) throw new Error(`${LLM_ENRICH_STEP} is missing from index.ts's workflow`);
  return llmEnrichStep.run(context(payload));
}

let client: PoolClient;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  if (!pool) return;
  for (const key of ["LLM_ENRICHMENT_ENABLED", "LLM_ENRICHMENT_PROVIDER", "LLM_ENRICHMENT_MODEL", "MOONSHOT_API_KEY", "POSTHOG_ENABLED"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // The override under test.
  process.env.LLM_ENRICHMENT_ENABLED = "false";

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

describe.skipIf(!pool)(`${LLM_ENRICH_STEP} — the fail-closed gate`, () => {
  it("is registered on the workflow", () => {
    expect(llmEnrichStep, `${LLM_ENRICH_STEP} is missing from index.ts's workflow`).toBeDefined();
  });

  it("marks the recipe skipped and never constructs a provider when LLM_ENRICHMENT_ENABLED=false", async () => {
    const result = await run({ recipeId: GATED_ID });
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
    await expect(run({})).rejects.toThrow(/recipeId/);
  });

  it("completes as `gone` for a recipe that no longer exists, rather than failing the job", async () => {
    // The gate is checked BEFORE the load, so a gated run never gets here —
    // re-enable the override for this one case to reach the load itself.
    process.env.LLM_ENRICHMENT_ENABLED = "true";
    try {
      // `markLlmSkipped` is not reached either: there is no row to mark, and a
      // deleted recipe is not a failure — jobs outlive rows.
      expect(await run({ recipeId: GONE_ID })).toEqual({ status: "gone" });
    } finally {
      process.env.LLM_ENRICHMENT_ENABLED = "false";
    }
  });
});

if (skipReason) {
  // Keeps the file from looking like it passed when it did nothing.
  describe.skip(`llm-enrich gate DB test (skipped: ${skipReason})`, () => {});
}
