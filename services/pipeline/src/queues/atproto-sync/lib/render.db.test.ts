import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentFingerprint, normalizeSourceUrl } from "@buttery/recipe-schemas/normalize";
import type { RecipeRow } from "#/queues/atproto-sync/lib/recipe.ts";
import { renderRecipe } from "#/queues/atproto-sync/lib/render.ts";

/**
 * The same golden vector as `render.test.ts` and
 * `services/web/src/db/backfill-recipe-dedupe-keys.test.ts`, restated rather
 * than imported: importing another *.test.ts would re-register its suite here,
 * and the three copies existing independently is the point — they are the
 * cross-path byte-identity contract of §6.6, not a shared helper.
 */
const GOLDEN = {
  name: "Crème Brûlée",
  ingredients: ["  2 CUPS   heavy cream ", "½ cup Sugar", "(4 egg yolks),"],
  sourceUrl: "https://cooking.nytimes.com/recipes/1017-classic-creme-brulee?action=click&module=Rank&pgType=recipe&utm_source=nl&servings=6#top",
  contentFp: "sha256:89480081b831f33effb3ccc89f80e24c0823faedf4263a647c3cfd52501a0dec",
  sourceUrlKey: "cooking.nytimes.com/recipes/1017-classic-creme-brulee?servings=6",
} as const;

/**
 * The sweep's render path writes the dedupe sidecar (paprika-import plan
 * §6.6 "writer 3", acceptance §16.21).
 *
 * This needs a real migrated Postgres — the whole point is what a unit test
 * cannot see: that the rows actually land through `renderRecipe`'s real SQL,
 * that a re-render REPLACES them rather than leaving keys describing content
 * that no longer exists, and that a key which goes away leaves no row behind.
 *
 *   pnpm --filter @buttery/pipeline test:db
 *
 * With no reachable database the suite SKIPS with a message rather than
 * failing, so `pnpm test` stays green on a machine that has never booted the
 * stack. See `vitest.config.ts` for the project split.
 *
 * Every test namespaces its rows under one per-run DID and deletes them in
 * `afterAll` (`recipe_meta` cascades off `recipe`), so a run leaves the dev
 * database exactly as it found it.
 */

// --- reachability probe --------------------------------------------------

let skipReason = "";

/** Module-load `console` belongs to no task and vitest drops it; stderr reaches the terminal. */
function announceSkip(reason: string): void {
  skipReason = reason;
  process.stderr.write(`\nSKIPPING atproto-sync render DB tests — ${reason}.\nRun them with \`pnpm --filter @buttery/pipeline test:db\` against the dev stack.\n\n`);
}

async function connectOrSkip(): Promise<Pool | null> {
  if (!process.env.DATABASE_URL) {
    announceSkip("DATABASE_URL is not set");
    return null;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // Probe `recipe_meta` specifically: a database that is up but has not run
    // the sidecar migrations would otherwise fail with an unhelpful
    // "relation does not exist" on every test.
    await Promise.race([pool.query("select 1 from recipe_meta limit 0"), new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 5s")), 5_000).unref?.())]);
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
const DID = `did:test:render-${RUN}`;
const RKEY = `01TESTRENDER${RUN}`.slice(0, 26).padEnd(26, "X");

/** A valid `exchange.recipe.recipe`-shaped record over the golden fixture. */
function recipeRow(over: { name?: string; ingredients?: string[]; url?: string | null; rev: string }): RecipeRow {
  const name = over.name ?? GOLDEN.name;
  const ingredients = over.ingredients ?? [...GOLDEN.ingredients];
  const url = over.url === undefined ? GOLDEN.sourceUrl : over.url;
  return {
    did: DID,
    rkey: RKEY,
    collection: "exchange.recipe.recipe",
    uri: `at://${DID}/exchange.recipe.recipe/${RKEY}`,
    cid: `bafytest${over.rev}`,
    rev: over.rev,
    record: {
      $type: "exchange.recipe.recipe",
      name,
      text: "A custard.",
      ingredients,
      instructions: ["Bake.", "Chill."],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...(url === null ? {} : { attribution: { $type: "exchange.recipe.defs#attributionWebsite", name: "NYT Cooking", url } }),
    },
    name,
    recordCreatedAt: "2026-01-01T00:00:00.000Z",
    recordUpdatedAt: "2026-01-01T00:00:00.000Z",
    validationStatus: "valid",
  };
}

/** Every `ns='dedupe'` row for the fixture recipe, as a plain key → value map. */
async function dedupeRows(client: PoolClient): Promise<Record<string, string>> {
  const res = await client.query<{ key: string; value: string }>(`select key, value #>> '{}' as value from recipe_meta where recipe_id = $1 and ns = 'dedupe' order by key`, [
    RKEY,
  ]);
  return Object.fromEntries(res.rows.map((r) => [r.key, r.value]));
}

/** The fixture recipe's `recipe_enrichment` row, or `null` if none exists yet. */
async function enrichmentRow(client: PoolClient): Promise<{ status: string; classifier_version: number; input_hash: string | null } | null> {
  const res = await client.query<{ status: string; classifier_version: number; input_hash: string | null }>(
    `select status, classifier_version, input_hash from recipe_enrichment where recipe_id = $1`,
    [RKEY],
  );
  return res.rows[0] ?? null;
}

let client: PoolClient;

beforeAll(async () => {
  if (!pool) return;
  client = await pool.connect();
  // Start from nothing so a crashed previous run cannot make a test pass.
  await client.query(`delete from recipe where id = $1`, [RKEY]);
});

afterAll(async () => {
  if (!pool) return;
  await client.query(`delete from recipe where id = $1`, [RKEY]).catch(() => {});
  client.release();
  await pool.end();
});

// --- tests ---------------------------------------------------------------

describe.skipIf(!pool)("renderRecipe dedupe keys", () => {
  it("populates both recipe_meta rows for a newly rendered record", async () => {
    await renderRecipe(client, recipeRow({ rev: "3aaaaaaaaaaa2" }));

    expect(await dedupeRows(client)).toEqual({
      // Byte-identical to the web write path and the backfill migration (§6.6):
      // the same literals are asserted in `render.test.ts` and in
      // `services/web/src/db/backfill-recipe-dedupe-keys.test.ts`.
      content_fp: GOLDEN.contentFp,
      source_url_key: GOLDEN.sourceUrlKey,
    });
  });

  it("replaces the keys on re-render rather than leaving stale ones", async () => {
    const name = "Vanilla Custard";
    const ingredients = ["3 cups whole milk", "6 egg yolks"];
    const url = "https://www.example.com/custard/?utm_campaign=x";
    await renderRecipe(client, recipeRow({ name, ingredients, url, rev: "3aaaaaaaaaaa3" }));

    const rows = await dedupeRows(client);
    // Exactly two rows: the old pair must be GONE, not sitting alongside the new
    // pair describing a name and an ingredient list that no longer exist.
    expect(Object.keys(rows).sort()).toEqual(["content_fp", "source_url_key"]);
    expect(rows.content_fp).toBe(await contentFingerprint(name, ingredients));
    expect(rows.source_url_key).toBe(normalizeSourceUrl(url));
    expect(rows.content_fp).not.toBe(GOLDEN.contentFp);
    expect(rows.source_url_key).not.toBe(GOLDEN.sourceUrlKey);
  });

  it("drops source_url_key when the re-rendered record no longer carries a URL", async () => {
    await renderRecipe(client, recipeRow({ url: null, rev: "3aaaaaaaaaaa4" }));

    // A key that goes away must leave no row behind — a bare upsert would keep
    // the previous URL's key alive forever and keep matching imports to it.
    expect(await dedupeRows(client)).toEqual({ content_fp: GOLDEN.contentFp });
  });

  it("removes the keys with the rendered row when the record turns invalid", async () => {
    // DELETE_RENDERED_SQL drops the sync row; `recipe_meta`'s FK cascades. This
    // is correct, and it is why re-render is the only thing that puts them back.
    await renderRecipe(client, { ...recipeRow({ rev: "3aaaaaaaaaaa5" }), validationStatus: "invalid" });

    expect(await dedupeRows(client)).toEqual({});
    const still = await client.query(`select 1 from recipe where id = $1`, [RKEY]);
    expect(still.rowCount).toBe(0);
  });
});

// --- recipe_enrichment staleness (recipe-enrichment plan §9) -------------

describe.skipIf(!pool)("renderRecipe marks recipe_enrichment stale", () => {
  it("upserts status='stale' and returns the recipe id when content advances", async () => {
    const id = await renderRecipe(client, recipeRow({ rev: "3aaaaaaaaaaa6" }));

    expect(id).toBe(RKEY);
    expect(await enrichmentRow(client)).toEqual({ status: "stale", classifier_version: 0, input_hash: null });
  });

  it("leaves recipe_enrichment untouched and returns null when the upsert does not advance (stale rev)", async () => {
    // Simulate the enrich step having already classified this content.
    await client.query(`update recipe_enrichment set status = 'ok', classifier_version = 1, input_hash = 'existing-hash' where recipe_id = $1`, [RKEY]);

    // Same rev as the row already stored: the upsert's rev guard skips it, so
    // this lands in the `rowCount === 0` branch, not the advancing one.
    const id = await renderRecipe(client, recipeRow({ rev: "3aaaaaaaaaaa6" }));

    expect(id).toBeNull();
    expect(await enrichmentRow(client)).toEqual({ status: "ok", classifier_version: 1, input_hash: "existing-hash" });
  });

  it("marks stale again without clearing classifier_version or input_hash", async () => {
    await client.query(`update recipe_enrichment set status = 'ok', classifier_version = 2, input_hash = 'keep-me' where recipe_id = $1`, [RKEY]);

    // A newer rev: content advances, so this recipe goes back to stale — but
    // the enrich step's own bookkeeping must survive so it can still compare
    // against it and short-circuit an unchanged recipe.
    const id = await renderRecipe(client, recipeRow({ rev: "3aaaaaaaaaaa7" }));

    expect(id).toBe(RKEY);
    expect(await enrichmentRow(client)).toEqual({ status: "stale", classifier_version: 2, input_hash: "keep-me" });
  });
});

if (!pool) it.skip(`skipped: ${skipReason}`, () => {});
