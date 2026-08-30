import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Label } from "#/queues/recipe-enrichment/types.ts";
import {
  claimBatch,
  claimLlmBatch,
  describeWriteError,
  getLlmEnrichmentState,
  loadRecipe,
  markError,
  markLlmError,
  markLlmSkipped,
  writeEnrichment,
  writeLlmEnrichment,
} from "#/queues/recipe-enrichment/lib/load.ts";

/**
 * `lib/load.ts`'s Postgres-touching half: the `enrich` write transaction, the
 * cascade delete (D11), and the `backfill` claim query's ordering (§7.2) —
 * plus, per the llm plan (§9.1, §9.2), the method-scoped delete's two
 * scopings, the cascade-on-content-change, `writeLlmEnrichment`'s own
 * transaction (including the PK-collision on-conflict case), `markLlmError`/
 * `markLlmSkipped`, and every arm of `claimLlmBatch`'s predicate.
 *
 * This needs a real migrated Postgres — the whole point is what a unit test
 * cannot see: that labels actually land through the real SQL, that a
 * re-write REPLACES them wholesale, and that deleting a `recipe` takes its
 * enrichment with it without a restrict violation.
 *
 *   pnpm --filter @buttery/pipeline test:db
 *
 * With no reachable database the suite SKIPS with a message rather than
 * failing, so `pnpm test` stays green on a machine that has never booted the
 * stack (AGENTS.md). See `vitest.config.ts` for the project split.
 *
 * Deliberately does not import `steps.ts` or `classify.ts` — see `lib/load.ts`'s
 * module doc for why: this suite has to run whether or not the classifier
 * agent's module exists yet. Same reasoning extends to the LLM half: this file
 * does not import `llm/schema.ts` either, and constructs `llm:`-prefixed
 * `method` strings by hand in fixtures rather than via `llmMethod()`.
 *
 * Every test namespaces its rows under one per-run id and deletes them in
 * `afterAll`, so a run leaves the dev database exactly as it found it.
 */

// --- reachability probe --------------------------------------------------

let skipReason = "";

/** Module-load `console` belongs to no task and vitest drops it; stderr reaches the terminal. */
function announceSkip(reason: string): void {
  skipReason = reason;
  process.stderr.write(`\nSKIPPING recipe-enrichment load DB tests — ${reason}.\nRun them with \`pnpm --filter @buttery/pipeline test:db\` against the dev stack.\n\n`);
}

async function connectOrSkip(): Promise<Pool | null> {
  if (!process.env.DATABASE_URL) {
    announceSkip("DATABASE_URL is not set");
    return null;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // Probe recipe_enrichment AND its llm_status column specifically: a
    // database that is up but has not run the base migration fails on the
    // table; one that has the table but not yet the llm plan's
    // `1787783591746_llm_recipe_enrichment` migration (written concurrently
    // by another agent) fails on the column instead of every LLM test
    // throwing an opaque "column llm_status does not exist". Either way this
    // suite should skip, not fail.
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

// --- fixture -------------------------------------------------------------

/** One namespace per run so a crashed run can never collide with the next. */
const RUN = Date.now().toString(36).toUpperCase().padStart(10, "0").slice(-10);
const recipeId = (label: string) => `test-enrich-${RUN}-${label}`;
const HOUSEHOLD_ID = `test-enrich-household-${RUN}`;

// Three recipes exercising the three ORDER BY buckets `claimBatch` sorts
// into: origin='local' first, then anything boxed, then the long tail. Reused
// below for `claimLlmBatch`'s own ordering test (llm plan §9.2) — same
// buckets, same reasoning, one fixture set.
const LOCAL_ID = recipeId("aaa-local"); // origin='local' — sorts first regardless of id text
const BOXED_ID = recipeId("zzz-boxed"); // origin='sync', boxed via household_recipe — sorts second
const OTHER_ID = recipeId("bbb-other"); // origin='sync', unboxed — sorts last

// llm plan fixtures. Kept separate from the three above so the LLM-specific
// tests can freely mutate `llm_status`/`llm_version` without disturbing the
// three recipes `claimLlmBatch`'s own ordering test depends on staying at
// `llm_status is null` until it runs (see that test).
const LLM_SCOPE_ID = recipeId("llm-scope"); // writeEnrichment/writeLlmEnrichment method-scoping + PK-collision
const LLM_MARK_ID = recipeId("llm-mark"); // markLlmError / markLlmSkipped against an existing row
const LLM_NOROW_ID = recipeId("llm-norow"); // markLlmError upsert with no recipe_enrichment row yet
const LLM_NOROW_SKIP_ID = recipeId("llm-norow-skip"); // markLlmSkipped upsert with no recipe_enrichment row yet
const LLM_CLAIM_NULL_ID = recipeId("llm-claim-null"); // llm_status is null
const LLM_CLAIM_ERROR_ID = recipeId("llm-claim-error"); // llm_status = 'error'
const LLM_CLAIM_STALE_ID = recipeId("llm-claim-stale"); // llm_status = 'ok', llm_version behind current
const LLM_CLAIM_CURRENT_ID = recipeId("llm-claim-current"); // llm_status = 'ok', llm_version = current — only force claims it
const LLM_CLAIM_SKIPPED_ID = recipeId("llm-claim-skipped"); // llm_status = 'skipped' at current llm_version — only force claims it
const LLM_CLAIM_NOTOK_ID = recipeId("llm-claim-notok"); // recipe_enrichment.status <> 'ok' — never claimed regardless of llm_status

const ALL_IDS = [
  LOCAL_ID,
  BOXED_ID,
  OTHER_ID,
  LLM_SCOPE_ID,
  LLM_MARK_ID,
  LLM_NOROW_ID,
  LLM_NOROW_SKIP_ID,
  LLM_CLAIM_NULL_ID,
  LLM_CLAIM_ERROR_ID,
  LLM_CLAIM_STALE_ID,
  LLM_CLAIM_CURRENT_ID,
  LLM_CLAIM_SKIPPED_ID,
  LLM_CLAIM_NOTOK_ID,
];

let client: PoolClient;

async function insertRecipe(client: PoolClient, id: string, origin: "local" | "sync"): Promise<void> {
  await client.query(`insert into recipe (id, origin, name) values ($1, $2, $3)`, [id, origin, `Test recipe ${id}`]);
}

/** The fixture recipe's `recipe_enrichment` row, or `null` if none exists. */
async function enrichmentRow(client: PoolClient, id: string): Promise<{ status: string; classifier_version: number; input_hash: string | null } | null> {
  const res = await client.query<{ status: string; classifier_version: number; input_hash: string | null }>(
    `select status, classifier_version, input_hash from recipe_enrichment where recipe_id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

/** Every label row for the fixture recipe, as `dimension/slug` strings, sorted. */
async function labelKeys(client: PoolClient, id: string): Promise<string[]> {
  const res = await client.query<{ dimension: string; slug: string }>(`select dimension, slug from recipe_enrichment_label where recipe_id = $1`, [id]);
  return res.rows.map((row) => `${row.dimension}/${row.slug}`).sort();
}

/** `dimension/slug -> method` for every label row, so a test can see WHICH provider owns a slug, not just that it exists. */
async function labelMethods(client: PoolClient, id: string): Promise<Record<string, string>> {
  const res = await client.query<{ dimension: string; slug: string; method: string }>(`select dimension, slug, method from recipe_enrichment_label where recipe_id = $1`, [id]);
  return Object.fromEntries(res.rows.map((row) => [`${row.dimension}/${row.slug}`, row.method]));
}

/** The fixture recipe's LLM-side `recipe_enrichment` columns, or `null` if no row exists. */
async function llmRow(
  client: PoolClient,
  id: string,
): Promise<{
  llm_status: string | null;
  llm_version: number;
  llm_input_hash: string | null;
  llm_model: string | null;
  llm_prompt_version: number | null;
  llm_error: string | null;
} | null> {
  const res = await client.query<{
    llm_status: string | null;
    llm_version: number;
    llm_input_hash: string | null;
    llm_model: string | null;
    llm_prompt_version: number | null;
    llm_error: string | null;
  }>(`select llm_status, llm_version, llm_input_hash, llm_model, llm_prompt_version, llm_error from recipe_enrichment where recipe_id = $1`, [id]);
  return res.rows[0] ?? null;
}

async function cleanup(client: PoolClient): Promise<void> {
  // household_recipe.recipe_id is ON DELETE RESTRICT (unlike the enrichment
  // tables, D11) — it has to go before the recipe rows it boxes, or the
  // delete below fails instead of testing anything.
  await client.query(`delete from household_recipe where household_id = $1`, [HOUSEHOLD_ID]);
  await client.query(`delete from household where id = $1`, [HOUSEHOLD_ID]);
  await client.query(`delete from recipe where id = any($1::text[])`, [ALL_IDS]);
}

beforeAll(async () => {
  if (!pool) return;
  client = await pool.connect();
  // Start from nothing so a crashed previous run cannot make a test pass.
  await cleanup(client);

  await insertRecipe(client, LOCAL_ID, "local");
  await insertRecipe(client, BOXED_ID, "sync");
  await insertRecipe(client, OTHER_ID, "sync");
  await insertRecipe(client, LLM_SCOPE_ID, "sync");
  await insertRecipe(client, LLM_MARK_ID, "sync");
  await insertRecipe(client, LLM_NOROW_ID, "sync");
  await insertRecipe(client, LLM_NOROW_SKIP_ID, "sync");
  await insertRecipe(client, LLM_CLAIM_NULL_ID, "sync");
  await insertRecipe(client, LLM_CLAIM_ERROR_ID, "sync");
  await insertRecipe(client, LLM_CLAIM_STALE_ID, "sync");
  await insertRecipe(client, LLM_CLAIM_CURRENT_ID, "sync");
  await insertRecipe(client, LLM_CLAIM_SKIPPED_ID, "sync");
  await insertRecipe(client, LLM_CLAIM_NOTOK_ID, "sync");

  await client.query(`insert into household (id, name, created_by_did) values ($1, 'Test household', 'did:test:enrich')`, [HOUSEHOLD_ID]);
  await client.query(`insert into household_recipe (household_id, recipe_id, added_by_did) values ($1, $2, 'did:test:enrich')`, [HOUSEHOLD_ID, BOXED_ID]);
});

afterAll(async () => {
  if (!pool) return;
  await cleanup(client).catch(() => {});
  client.release();
  await pool.end();
});

// --- writeEnrichment: the transaction (plan §7.1 step 5) -----------------

describe.skipIf(!pool)("writeEnrichment", () => {
  const label = (over: Partial<Label>): Label => ({
    dimension: "diet",
    slug: "vegetarian",
    verdict: "excluded",
    confidence: 0.9,
    method: "rules@1",
    evidence: { rule: "test-rule", lines: [{ ordinal: 1, text: "fish sauce", foodSlug: "en:fish-sauce" }] },
    ...over,
  });

  it("upserts recipe_enrichment to ok and inserts every label", async () => {
    await writeEnrichment(
      pool as Pool,
      LOCAL_ID,
      "sha256:v1",
      1,
      [label({ dimension: "diet", slug: "vegetarian", verdict: "excluded" }), label({ dimension: "allergen", slug: "fish", verdict: "contains" })],
      { contentChanged: false },
    );

    expect(await enrichmentRow(client, LOCAL_ID)).toEqual({ status: "ok", classifier_version: 1, input_hash: "sha256:v1" });
    expect(await labelKeys(client, LOCAL_ID)).toEqual(["allergen/fish", "diet/vegetarian"]);
  });

  it("replaces the label set wholesale rather than merging into it", async () => {
    // A verdict a classifier no longer emits must not survive as a stale row —
    // this run's labels look nothing like the previous test's.
    await writeEnrichment(pool as Pool, LOCAL_ID, "sha256:v2", 2, [label({ dimension: "allergen", slug: "milk", verdict: "not_detected", confidence: 0.5 })], {
      contentChanged: false,
    });

    expect(await enrichmentRow(client, LOCAL_ID)).toEqual({ status: "ok", classifier_version: 2, input_hash: "sha256:v2" });
    expect(await labelKeys(client, LOCAL_ID)).toEqual(["allergen/milk"]);
  });

  it("clears zero labels back to none without leaving the previous set behind", async () => {
    await writeEnrichment(pool as Pool, LOCAL_ID, "sha256:v3", 2, [], { contentChanged: false });

    expect(await enrichmentRow(client, LOCAL_ID)).toEqual({ status: "ok", classifier_version: 2, input_hash: "sha256:v3" });
    expect(await labelKeys(client, LOCAL_ID)).toEqual([]);
  });

  it("rolls back the whole transaction and surfaces a legible message for an unseeded (dimension, slug)", async () => {
    // Classifiers only ever emit seeded slugs (plan §7.1) — this simulates the
    // "should be impossible" case and pins that it fails loudly rather than
    // landing a half-written label set.
    const before = await labelKeys(client, LOCAL_ID);

    await expect(writeEnrichment(pool as Pool, LOCAL_ID, "sha256:bad", 3, [label({ dimension: "diet", slug: "not-a-real-slug" })], { contentChanged: false })).rejects.toThrow();

    // Nothing committed: not the bad label, not even the one good label it was
    // paired with, and not the status='ok' upsert.
    expect(await labelKeys(client, LOCAL_ID)).toEqual(before);
    expect(await enrichmentRow(client, LOCAL_ID)).toEqual({ status: "ok", classifier_version: 2, input_hash: "sha256:v3" });

    try {
      await writeEnrichment(pool as Pool, LOCAL_ID, "sha256:bad", 3, [label({ dimension: "diet", slug: "not-a-real-slug" })], { contentChanged: false });
      expect.unreachable("writeEnrichment should have thrown");
    } catch (err) {
      const message = describeWriteError(err);
      expect(message).toContain("unseeded");
      expect(message).toContain("not-a-real-slug");
    }
  });
});

// --- method-scoped writeEnrichment + writeLlmEnrichment (llm plan §9.1) ---

describe.skipIf(!pool)("writeEnrichment method scoping + writeLlmEnrichment", () => {
  const rulesLabel = (over: Partial<Label>): Label => ({
    dimension: "diet",
    slug: "vegetarian",
    verdict: "excluded",
    confidence: 0.9,
    method: "rules@1",
    evidence: { rule: "test-rule", lines: [] },
    ...over,
  });
  const llmLabel = (over: Partial<Label>): Label => ({
    dimension: "cuisine",
    slug: "italian",
    verdict: "likely",
    confidence: 0.7,
    method: "llm:mock:test-model@v1",
    evidence: { rule: "llm", lines: [], note: "test fixture" },
    ...over,
  });

  it("step 1: an initial rules write has no llm rows to spare", async () => {
    await writeEnrichment(
      pool as Pool,
      LLM_SCOPE_ID,
      "sha256:scope-v1",
      1,
      [rulesLabel({ dimension: "diet", slug: "vegetarian", verdict: "excluded" }), rulesLabel({ dimension: "allergen", slug: "fish", verdict: "unknown", method: "rules@1" })],
      { contentChanged: false },
    );

    expect(await labelKeys(client, LLM_SCOPE_ID)).toEqual(["allergen/fish", "diet/vegetarian"]);
    expect(await labelMethods(client, LLM_SCOPE_ID)).toEqual({ "allergen/fish": "rules@1", "diet/vegetarian": "rules@1" });
  });

  it("step 2: writeLlmEnrichment replaces the rules `unknown` row IN PLACE (the PK-collision case) and adds an LLM-only row, leaving the other rules row standing", async () => {
    await writeLlmEnrichment(pool as Pool, LLM_SCOPE_ID, { llmVersion: 7, llmInputHash: "sha256:scope-v1", llmModel: "mock:test-model", llmPromptVersion: 3 }, [
      // Resolves the rules `unknown` on allergen/fish — same (recipe_id,
      // dimension, slug) key the rules row above already occupies. This is
      // llm plan §8's "replacing the rules `unknown` row" case: it must
      // land via ON CONFLICT, not a plain insert, or this throws 23505.
      llmLabel({ dimension: "allergen", slug: "fish", verdict: "contains", method: "llm:mock:test-model@v7" }),
      // A dimension the rules classifier never writes at all — no collision, a plain insert.
      llmLabel({ dimension: "cuisine", slug: "italian", verdict: "likely", method: "llm:mock:test-model@v7" }),
    ]);

    expect(await labelKeys(client, LLM_SCOPE_ID)).toEqual(["allergen/fish", "cuisine/italian", "diet/vegetarian"]);
    const methods = await labelMethods(client, LLM_SCOPE_ID);
    // The rules `unknown` row is GONE — replaced in place, not sitting beside the LLM row.
    expect(methods["allergen/fish"]).toBe("llm:mock:test-model@v7");
    // The rules row on a slug the LLM said nothing about is untouched.
    expect(methods["diet/vegetarian"]).toBe("rules@1");
    expect(methods["cuisine/italian"]).toBe("llm:mock:test-model@v7");

    // llm_* columns record the run; the rules columns are untouched by this function.
    expect(await llmRow(client, LLM_SCOPE_ID)).toEqual({
      llm_status: "ok",
      llm_version: 7,
      llm_input_hash: "sha256:scope-v1",
      llm_model: "mock:test-model",
      llm_prompt_version: 3,
      llm_error: null,
    });
    expect(await enrichmentRow(client, LLM_SCOPE_ID)).toEqual({ status: "ok", classifier_version: 1, input_hash: "sha256:scope-v1" });
  });

  it("step 3: a rules re-run with contentChanged=false spares the llm:%-owned rows and only replaces its own", async () => {
    await writeEnrichment(
      pool as Pool,
      LLM_SCOPE_ID,
      "sha256:scope-v1", // same content — this is a version bump reclassify, not a content change
      2,
      [
        rulesLabel({ dimension: "diet", slug: "vegetarian", verdict: "excluded", method: "rules@2" }),
        rulesLabel({ dimension: "allergen", slug: "milk", verdict: "contains", method: "rules@2" }),
      ],
      { contentChanged: false },
    );

    // Both llm:%-owned rows (the replaced allergen/fish AND the llm-only
    // cuisine/italian) survive a rules-scoped delete untouched.
    expect(await labelKeys(client, LLM_SCOPE_ID)).toEqual(["allergen/fish", "allergen/milk", "cuisine/italian", "diet/vegetarian"]);
    const methods = await labelMethods(client, LLM_SCOPE_ID);
    expect(methods["allergen/fish"]).toBe("llm:mock:test-model@v7");
    expect(methods["cuisine/italian"]).toBe("llm:mock:test-model@v7");
    expect(methods["diet/vegetarian"]).toBe("rules@2");
    expect(methods["allergen/milk"]).toBe("rules@2");

    // writeEnrichment never touches the llm_* columns.
    expect(await llmRow(client, LLM_SCOPE_ID)).toMatchObject({ llm_status: "ok", llm_version: 7 });
  });

  it("step 4: the reverse collision — a rules re-run recomputing the SAME slug an llm: row owns overwrites it back to rules, on-conflict rather than crashing", async () => {
    await writeEnrichment(
      pool as Pool,
      LLM_SCOPE_ID,
      "sha256:scope-v1",
      3,
      [
        rulesLabel({ dimension: "diet", slug: "vegetarian", verdict: "excluded", method: "rules@3" }),
        rulesLabel({ dimension: "allergen", slug: "fish", verdict: "unknown", method: "rules@3" }),
      ],
      { contentChanged: false },
    );

    // allergen/fish is back to a rules row — the LLM's earlier resolution was
    // overwritten in place (see writeEnrichment's doc comment: accepted
    // because `enrich` re-enqueues `llm-enrich` immediately, which will
    // re-resolve it on the next run).
    const methods = await labelMethods(client, LLM_SCOPE_ID);
    expect(methods["allergen/fish"]).toBe("rules@3");
    // The other llm-only row is unaffected — the rules write never mentioned that slug.
    expect(methods["cuisine/italian"]).toBe("llm:mock:test-model@v7");
    // allergen/milk is gone — this rules write no longer emits it, and it was a rules-owned row.
    expect(await labelKeys(client, LLM_SCOPE_ID)).toEqual(["allergen/fish", "cuisine/italian", "diet/vegetarian"]);

    // llm_status still reads 'ok' at version 7 even though the row it produced
    // for allergen/fish just got clobbered — writeEnrichment has no reason to
    // touch llm_* columns, and the short-circuit's job is done by input_hash,
    // not by cross-checking which llm: rows currently exist.
    expect(await llmRow(client, LLM_SCOPE_ID)).toMatchObject({ llm_status: "ok", llm_version: 7 });
  });

  it("step 5: contentChanged=true deletes EVERYTHING, llm:%-owned rows included", async () => {
    await writeEnrichment(pool as Pool, LLM_SCOPE_ID, "sha256:scope-v2", 4, [rulesLabel({ dimension: "diet", slug: "vegetarian", verdict: "excluded", method: "rules@4" })], {
      contentChanged: true,
    });

    // cuisine/italian (llm-only) is gone too — its evidence was about
    // ingredients this recipe no longer has.
    expect(await labelKeys(client, LLM_SCOPE_ID)).toEqual(["diet/vegetarian"]);
    expect(await labelMethods(client, LLM_SCOPE_ID)).toEqual({ "diet/vegetarian": "rules@4" });

    // llm_status is left at whatever it was — writeEnrichment does not reset
    // it on a content change. The recipe now has llm_status='ok' but zero
    // llm:%-owned rows, which is fine: `enrich` unconditionally re-enqueues
    // `llm-enrich`, and that job's OWN short-circuit (plan §3.1) sees
    // llm_input_hash ("sha256:scope-v1") no longer match the new fingerprint
    // ("sha256:scope-v2") and reclassifies regardless of llm_status.
    expect(await llmRow(client, LLM_SCOPE_ID)).toMatchObject({ llm_status: "ok", llm_input_hash: "sha256:scope-v1" });
  });
});

// --- getLlmEnrichmentState: both halves in one query (llm plan §9.2 step 3) --

describe.skipIf(!pool)("getLlmEnrichmentState", () => {
  it("returns null for a recipe that has never been classified", async () => {
    expect(await getLlmEnrichmentState(pool as Pool, recipeId("never-classified"))).toBeNull();
  });

  it("returns both the rules half and the llm half from one row", async () => {
    // LLM_SCOPE_ID finished the describe block above at step 5: rules
    // classifier_version 4 / input_hash "sha256:scope-v2", llm half still at
    // llm_status='ok' / llm_version=7 / llm_input_hash="sha256:scope-v1" (the
    // OLD content — that mismatch is exactly what the step's own
    // short-circuit reads to decide it must reclassify).
    expect(await getLlmEnrichmentState(pool as Pool, LLM_SCOPE_ID)).toEqual({
      status: "ok",
      inputHash: "sha256:scope-v2",
      // The rules `classifier_version` travels too: `llm-enrich` re-derives the
      // rules labels rather than reading them back, so it has to know it is
      // running the same classifier that wrote the rows it is about to reason
      // against (see that step, and this field's own doc in `load.ts`).
      classifierVersion: 4,
      llmStatus: "ok",
      llmVersion: 7,
      llmInputHash: "sha256:scope-v1",
      // Who answered last time, which `isLlmFresh` compares against who would
      // answer now — a released prompt version or a swapped model makes the
      // stored labels stale on unchanged content.
      llmModel: "mock:test-model",
      llmPromptVersion: 3,
    });
  });
});

// --- markLlmError / markLlmSkipped (llm plan §3.1) ------------------------

describe.skipIf(!pool)("markLlmError / markLlmSkipped", () => {
  it("markLlmError sets llm_status/llm_error and preserves llm_version/llm_input_hash from a prior run", async () => {
    await writeEnrichment(pool as Pool, LLM_MARK_ID, "sha256:mark-v1", 1, [], { contentChanged: false });
    await writeLlmEnrichment(pool as Pool, LLM_MARK_ID, { llmVersion: 5, llmInputHash: "sha256:mark-v1", llmModel: "mock:test-model", llmPromptVersion: 2 }, []);

    await markLlmError(pool as Pool, LLM_MARK_ID, "provider timeout after 3 attempts");

    expect(await llmRow(client, LLM_MARK_ID)).toEqual({
      llm_status: "error",
      llm_error: "provider timeout after 3 attempts",
      // Untouched — same reasoning as markError: the next attempt still has
      // something correct to compare its fingerprint/version against.
      llm_version: 5,
      llm_input_hash: "sha256:mark-v1",
      llm_model: "mock:test-model",
      llm_prompt_version: 2,
    });
    // The rules columns are untouched too.
    expect(await enrichmentRow(client, LLM_MARK_ID)).toEqual({ status: "ok", classifier_version: 1, input_hash: "sha256:mark-v1" });
  });

  it("markLlmSkipped sets llm_status='skipped', clears llm_error, and does NOT touch llm_version", async () => {
    // Continues from the previous test: LLM_MARK_ID is currently llm_status='error' at llm_version=5.
    await markLlmSkipped(pool as Pool, LLM_MARK_ID);

    const row = await llmRow(client, LLM_MARK_ID);
    expect(row?.llm_status).toBe("skipped");
    expect(row?.llm_error).toBeNull();
    // The load-bearing assertion (see markLlmSkipped's doc comment): llm_version
    // stays at 5, NOT stamped to "the current version". That is what lets a
    // non-force claimLlmBatch reclaim a brand-new (llm_version defaults to 0)
    // skipped recipe automatically once the flag turns back on, while a recipe
    // already at the current version when it was skipped stays skipped until
    // force or a version bump — see the `claimLlmBatch` tests below for both halves.
    expect(row?.llm_version).toBe(5);
  });

  it("markLlmError upserts when no recipe_enrichment row exists yet", async () => {
    expect(await llmRow(client, LLM_NOROW_ID)).toBeNull();

    await markLlmError(pool as Pool, LLM_NOROW_ID, "no rules row yet");

    const row = await llmRow(client, LLM_NOROW_ID);
    expect(row?.llm_status).toBe("error");
    expect(row?.llm_error).toBe("no rules row yet");
    expect(row?.llm_version).toBe(0); // the column's own default — never run
  });

  it("markLlmSkipped upserts when no recipe_enrichment row exists yet", async () => {
    expect(await llmRow(client, LLM_NOROW_SKIP_ID)).toBeNull();

    await markLlmSkipped(pool as Pool, LLM_NOROW_SKIP_ID);

    const row = await llmRow(client, LLM_NOROW_SKIP_ID);
    expect(row?.llm_status).toBe("skipped");
    expect(row?.llm_error).toBeNull();
    expect(row?.llm_version).toBe(0);
  });
});

// --- cascade delete (D11) -------------------------------------------------

describe.skipIf(!pool)("recipe delete cascades", () => {
  it("takes recipe_enrichment and recipe_enrichment_label with it, without a restrict violation (23001)", async () => {
    const label: Label = {
      dimension: "allergen",
      slug: "milk",
      verdict: "contains",
      confidence: 1,
      method: "rules@1",
      evidence: { rule: "test-rule", lines: [] },
    };
    await writeEnrichment(pool as Pool, OTHER_ID, "sha256:cascade", 1, [label], { contentChanged: false });
    expect(await enrichmentRow(client, OTHER_ID)).not.toBeNull();
    expect(await labelKeys(client, OTHER_ID)).toEqual(["allergen/milk"]);

    await expect(client.query(`delete from recipe where id = $1`, [OTHER_ID])).resolves.toBeDefined();

    expect(await enrichmentRow(client, OTHER_ID)).toBeNull();
    expect(await labelKeys(client, OTHER_ID)).toEqual([]);

    // Recreate it — later tests and the afterAll cleanup expect OTHER_ID to
    // still be a live recipe row.
    await insertRecipe(client, OTHER_ID, "sync");
  });
});

// --- loadRecipe: "gone" (plan §7.1 step 1) --------------------------------

describe.skipIf(!pool)("loadRecipe", () => {
  it("returns null for a recipe id that does not exist", async () => {
    expect(await loadRecipe(pool as Pool, `${recipeId("never-existed")}`)).toBeNull();
  });

  it("loads the name and ordered ingredient lines for one that does", async () => {
    await client.query(`insert into recipe_ingredient (recipe_id, ordinal, text) values ($1, 2, 'second'), ($1, 1, 'first')`, [BOXED_ID]);
    const loaded = await loadRecipe(pool as Pool, BOXED_ID);
    expect(loaded?.name).toBe(`Test recipe ${BOXED_ID}`);
    expect(loaded?.lines).toEqual([
      { ordinal: 1, text: "first" },
      { ordinal: 2, text: "second" },
    ]);
  });
});

// --- claimBatch: the backfill claim (plan §7.2) ---------------------------

// A version comfortably above anything the `writeEnrichment` describe block
// above left LOCAL_ID at (it ends that suite on classifier_version 2): these
// tests want all three fixture recipes to read as candidates regardless of
// which arm of the claim's UNION they fall into — missing row (BOXED_ID,
// OTHER_ID once recreated) or behind-version row (LOCAL_ID).
const AHEAD_OF_EVERY_FIXTURE_VERSION = 999;

describe.skipIf(!pool)("claimBatch ordering", () => {
  it("orders origin='local' first, then boxed, then the long tail", async () => {
    const { ids } = await claimBatch(pool as Pool, { classifierVersion: AHEAD_OF_EVERY_FIXTURE_VERSION, limit: 5000 });

    const local = ids.indexOf(LOCAL_ID);
    const boxed = ids.indexOf(BOXED_ID);
    const other = ids.indexOf(OTHER_ID);
    expect(local).toBeGreaterThanOrEqual(0);
    expect(boxed).toBeGreaterThanOrEqual(0);
    expect(other).toBeGreaterThanOrEqual(0);
    expect(local).toBeLessThan(boxed);
    expect(boxed).toBeLessThan(other);
  });

  it("reports how many candidates remain after a batch smaller than the total", async () => {
    const full = await claimBatch(pool as Pool, { classifierVersion: AHEAD_OF_EVERY_FIXTURE_VERSION, limit: 5000 });
    const total = full.ids.length;
    expect(total).toBeGreaterThanOrEqual(3);

    const page = await claimBatch(pool as Pool, { classifierVersion: AHEAD_OF_EVERY_FIXTURE_VERSION, limit: total - 1 });
    expect(page.ids.length).toBe(total - 1);
    expect(page.remaining).toBe(1);
  });

  it("excludes an ok, current-version recipe unless force is set", async () => {
    const label: Label = { dimension: "diet", slug: "vegan", verdict: "likely", confidence: 0.8, method: "rules@1", evidence: { rule: "test-rule", lines: [] } };
    await writeEnrichment(pool as Pool, OTHER_ID, "sha256:current", 5, [label], { contentChanged: false });

    const notForced = await claimBatch(pool as Pool, { classifierVersion: 5, limit: 5000 });
    expect(notForced.ids).not.toContain(OTHER_ID);

    const forced = await claimBatch(pool as Pool, { classifierVersion: 5, force: true, limit: 5000 });
    expect(forced.ids).toContain(OTHER_ID);
  });

  it("localOnly claims only origin='local' recipes", async () => {
    const { ids } = await claimBatch(pool as Pool, { classifierVersion: AHEAD_OF_EVERY_FIXTURE_VERSION, localOnly: true, limit: 5000 });
    expect(ids).toContain(LOCAL_ID);
    expect(ids).not.toContain(BOXED_ID);
    expect(ids).not.toContain(OTHER_ID);
  });
});

// --- claimLlmBatch: the llm-backfill claim (llm plan §9.2) ----------------

// Arbitrary and unrelated to the real `LLM_ENRICHMENT_VERSION` (this file
// does not import `llm/schema.ts` — see the module doc) — just a version
// number every fixture below is deliberately positioned around.
const CURRENT_LLM_VERSION = 42;

describe.skipIf(!pool)("claimLlmBatch", () => {
  beforeAll(async () => {
    // One fixture per predicate arm (llm plan §9.2):
    //   null           -- rules ok, llm-enrich never attempted
    //   error          -- rules ok, llm-enrich failed
    //   stale version  -- rules ok, llm ok but behind CURRENT_LLM_VERSION
    //   current        -- rules ok, llm ok AT CURRENT_LLM_VERSION -- force-only
    //   skipped        -- rules ok, llm skipped AT CURRENT_LLM_VERSION -- force-only
    //   not-ok         -- rules never finished -- never claimed, force or not
    await writeEnrichment(pool as Pool, LLM_CLAIM_NULL_ID, "sha256:claim-null", 1, [], { contentChanged: false });

    await writeEnrichment(pool as Pool, LLM_CLAIM_ERROR_ID, "sha256:claim-error", 1, [], { contentChanged: false });
    await markLlmError(pool as Pool, LLM_CLAIM_ERROR_ID, "provider timeout");

    await writeEnrichment(pool as Pool, LLM_CLAIM_STALE_ID, "sha256:claim-stale", 1, [], { contentChanged: false });
    await writeLlmEnrichment(
      pool as Pool,
      LLM_CLAIM_STALE_ID,
      { llmVersion: CURRENT_LLM_VERSION - 1, llmInputHash: "sha256:claim-stale", llmModel: "mock:test-model", llmPromptVersion: 1 },
      [],
    );

    await writeEnrichment(pool as Pool, LLM_CLAIM_CURRENT_ID, "sha256:claim-current", 1, [], { contentChanged: false });
    await writeLlmEnrichment(
      pool as Pool,
      LLM_CLAIM_CURRENT_ID,
      { llmVersion: CURRENT_LLM_VERSION, llmInputHash: "sha256:claim-current", llmModel: "mock:test-model", llmPromptVersion: 1 },
      [],
    );

    await writeEnrichment(pool as Pool, LLM_CLAIM_SKIPPED_ID, "sha256:claim-skipped", 1, [], { contentChanged: false });
    // Reaches llm_status='ok' at CURRENT_LLM_VERSION first, THEN gets skipped
    // (the flag flapped off) — the one way a skipped row ends up at the
    // current version rather than markLlmSkipped's own default (see that
    // function's doc comment and its own test above).
    await writeLlmEnrichment(
      pool as Pool,
      LLM_CLAIM_SKIPPED_ID,
      { llmVersion: CURRENT_LLM_VERSION, llmInputHash: "sha256:claim-skipped", llmModel: "mock:test-model", llmPromptVersion: 1 },
      [],
    );
    await markLlmSkipped(pool as Pool, LLM_CLAIM_SKIPPED_ID);

    await markError(pool as Pool, LLM_CLAIM_NOTOK_ID, "rules never finished");

    // BOXED_ID never went through writeEnrichment anywhere above (the rules
    // `claimBatch` ordering test above relies on it having NO recipe_enrichment
    // row at all, its own "missing row" arm) — but claimLlmBatch requires a
    // real status='ok' row to join against. Give it one here, after the rules
    // ordering assertions above have already run, so this ordering test below
    // has all three buckets to work with.
    await writeEnrichment(pool as Pool, BOXED_ID, "sha256:boxed-llm", 1, [], { contentChanged: false });
  });

  it("claims a recipe whose llm_status is null (never attempted)", async () => {
    const { ids } = await claimLlmBatch(pool as Pool, { llmVersion: CURRENT_LLM_VERSION, limit: 5000 });
    expect(ids).toContain(LLM_CLAIM_NULL_ID);
  });

  it("claims a recipe whose llm_status is 'error'", async () => {
    const { ids } = await claimLlmBatch(pool as Pool, { llmVersion: CURRENT_LLM_VERSION, limit: 5000 });
    expect(ids).toContain(LLM_CLAIM_ERROR_ID);
  });

  it("claims a recipe whose llm_version is behind the current version", async () => {
    const { ids } = await claimLlmBatch(pool as Pool, { llmVersion: CURRENT_LLM_VERSION, limit: 5000 });
    expect(ids).toContain(LLM_CLAIM_STALE_ID);
  });

  it("excludes an ok, current-version recipe unless force is set", async () => {
    const notForced = await claimLlmBatch(pool as Pool, { llmVersion: CURRENT_LLM_VERSION, limit: 5000 });
    expect(notForced.ids).not.toContain(LLM_CLAIM_CURRENT_ID);

    const forced = await claimLlmBatch(pool as Pool, { llmVersion: CURRENT_LLM_VERSION, force: true, limit: 5000 });
    expect(forced.ids).toContain(LLM_CLAIM_CURRENT_ID);
  });

  it("excludes a skipped recipe already at the current version unless force is set", async () => {
    const notForced = await claimLlmBatch(pool as Pool, { llmVersion: CURRENT_LLM_VERSION, limit: 5000 });
    expect(notForced.ids).not.toContain(LLM_CLAIM_SKIPPED_ID);

    const forced = await claimLlmBatch(pool as Pool, { llmVersion: CURRENT_LLM_VERSION, force: true, limit: 5000 });
    expect(forced.ids).toContain(LLM_CLAIM_SKIPPED_ID);
  });

  it("never claims a recipe whose rules pass is not status='ok', with or without force", async () => {
    const notForced = await claimLlmBatch(pool as Pool, { llmVersion: CURRENT_LLM_VERSION, limit: 5000 });
    expect(notForced.ids).not.toContain(LLM_CLAIM_NOTOK_ID);

    const forced = await claimLlmBatch(pool as Pool, { llmVersion: CURRENT_LLM_VERSION, force: true, limit: 5000 });
    expect(forced.ids).not.toContain(LLM_CLAIM_NOTOK_ID);
  });

  it("orders origin='local' first, then boxed, then the long tail — same buckets as claimBatch", async () => {
    // LOCAL_ID/BOXED_ID/OTHER_ID all reached status='ok' earlier in this file
    // and none of the llm-side functions ever touched them before this
    // block's own beforeAll gave BOXED_ID a row above — llm_status is null
    // for all three, so every one is a candidate via that arm alone.
    const { ids } = await claimLlmBatch(pool as Pool, { llmVersion: CURRENT_LLM_VERSION, limit: 5000 });

    const local = ids.indexOf(LOCAL_ID);
    const boxed = ids.indexOf(BOXED_ID);
    const other = ids.indexOf(OTHER_ID);
    expect(local).toBeGreaterThanOrEqual(0);
    expect(boxed).toBeGreaterThanOrEqual(0);
    expect(other).toBeGreaterThanOrEqual(0);
    expect(local).toBeLessThan(boxed);
    expect(boxed).toBeLessThan(other);
  });
});

if (!pool) it.skip(`skipped: ${skipReason}`, () => {});
