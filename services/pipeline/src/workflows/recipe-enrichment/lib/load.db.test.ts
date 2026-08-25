import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Label } from "#/workflows/recipe-enrichment/types.ts";
import { claimBatch, describeWriteError, loadRecipe, writeEnrichment } from "#/workflows/recipe-enrichment/lib/load.ts";

/**
 * `lib/load.ts`'s Postgres-touching half: the `enrich` write transaction, the
 * cascade delete (D11), and the `backfill` claim query's ordering (§7.2).
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
 * agent's module exists yet.
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
    // Probe recipe_enrichment specifically: a database that is up but has not
    // run this feature's migration would otherwise fail with an unhelpful
    // "relation does not exist" on every test.
    await Promise.race([
      pool.query("select 1 from recipe_enrichment limit 0"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 5s")), 5_000).unref?.()),
    ]);
    return pool;
  } catch (error) {
    announceSkip(`no reachable migrated database (${error instanceof Error ? error.message : String(error)})`);
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
// into: origin='local' first, then anything boxed, then the long tail.
const LOCAL_ID = recipeId("aaa-local"); // origin='local' — sorts first regardless of id text
const BOXED_ID = recipeId("zzz-boxed"); // origin='sync', boxed via household_recipe — sorts second
const OTHER_ID = recipeId("bbb-other"); // origin='sync', unboxed — sorts last
const ALL_IDS = [LOCAL_ID, BOXED_ID, OTHER_ID];

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
    await writeEnrichment(pool as Pool, LOCAL_ID, "sha256:v1", 1, [
      label({ dimension: "diet", slug: "vegetarian", verdict: "excluded" }),
      label({ dimension: "allergen", slug: "fish", verdict: "contains" }),
    ]);

    expect(await enrichmentRow(client, LOCAL_ID)).toEqual({ status: "ok", classifier_version: 1, input_hash: "sha256:v1" });
    expect(await labelKeys(client, LOCAL_ID)).toEqual(["allergen/fish", "diet/vegetarian"]);
  });

  it("replaces the label set wholesale rather than merging into it", async () => {
    // A verdict a classifier no longer emits must not survive as a stale row —
    // this run's labels look nothing like the previous test's.
    await writeEnrichment(pool as Pool, LOCAL_ID, "sha256:v2", 2, [label({ dimension: "allergen", slug: "milk", verdict: "not_detected", confidence: 0.5 })]);

    expect(await enrichmentRow(client, LOCAL_ID)).toEqual({ status: "ok", classifier_version: 2, input_hash: "sha256:v2" });
    expect(await labelKeys(client, LOCAL_ID)).toEqual(["allergen/milk"]);
  });

  it("clears zero labels back to none without leaving the previous set behind", async () => {
    await writeEnrichment(pool as Pool, LOCAL_ID, "sha256:v3", 2, []);

    expect(await enrichmentRow(client, LOCAL_ID)).toEqual({ status: "ok", classifier_version: 2, input_hash: "sha256:v3" });
    expect(await labelKeys(client, LOCAL_ID)).toEqual([]);
  });

  it("rolls back the whole transaction and surfaces a legible message for an unseeded (dimension, slug)", async () => {
    // Classifiers only ever emit seeded slugs (plan §7.1) — this simulates the
    // "should be impossible" case and pins that it fails loudly rather than
    // landing a half-written label set.
    const before = await labelKeys(client, LOCAL_ID);

    await expect(writeEnrichment(pool as Pool, LOCAL_ID, "sha256:bad", 3, [label({ dimension: "diet", slug: "not-a-real-slug" })])).rejects.toThrow();

    // Nothing committed: not the bad label, not even the one good label it was
    // paired with, and not the status='ok' upsert.
    expect(await labelKeys(client, LOCAL_ID)).toEqual(before);
    expect(await enrichmentRow(client, LOCAL_ID)).toEqual({ status: "ok", classifier_version: 2, input_hash: "sha256:v3" });

    try {
      await writeEnrichment(pool as Pool, LOCAL_ID, "sha256:bad", 3, [label({ dimension: "diet", slug: "not-a-real-slug" })]);
      expect.unreachable("writeEnrichment should have thrown");
    } catch (err) {
      const message = describeWriteError(err);
      expect(message).toContain("unseeded");
      expect(message).toContain("not-a-real-slug");
    }
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
    await writeEnrichment(pool as Pool, OTHER_ID, "sha256:cascade", 1, [label]);
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
    await writeEnrichment(pool as Pool, OTHER_ID, "sha256:current", 5, [label]);

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

if (!pool) it.skip(`skipped: ${skipReason}`, () => {});
