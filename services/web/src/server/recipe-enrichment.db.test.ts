import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "#/db/types";
import { ulid } from "./household/ids";

/**
 * DB-backed integration test for `getRecipeEnrichment` (recipe-enrichment plan
 * §10) — the one thing a unit test cannot see here: the real grouping-by-
 * dimension over two real tables, `numeric`/`jsonb`/`timestamptz` round-
 * tripping through the `pg` driver, and the shape returned for a recipe
 * nothing has enriched yet.
 *
 * Also covers the SPARSE case directly (`recipe-enrichment.ts`'s module doc:
 * "pass through sparse", not materialize): a recipe with only a couple of
 * stored labels out of a much larger `recipe_vocab` reads back exactly those
 * rows, with nothing synthesized for the slugs that were never written.
 *
 *   pnpm --filter @buttery/web exec vitest run --project db
 *
 * With no reachable database the suite SKIPS rather than fails, so `pnpm test`
 * stays green on a machine that has never booted the stack (AGENTS.md).
 */

// --- reachability probe --------------------------------------------------

function announceSkip(reason: string): void {
  process.stderr.write(
    `\nSKIPPING recipe-enrichment DB tests — ${reason}.\nRun them against the local dev stack with \`pnpm --filter @buttery/web exec vitest run --project db\`.\n\n`,
  );
}

async function connectOrSkip(): Promise<Kysely<DB> | null> {
  if (!process.env.DATABASE_URL) {
    announceSkip("DATABASE_URL is not set");
    return null;
  }
  const { getDb } = await import("#/lib/db");
  const db = getDb();
  try {
    await Promise.race([
      sql`select 1 from recipe_enrichment limit 0`.execute(db),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 5s")), 5_000).unref?.()),
    ]);
    return db;
  } catch (error) {
    announceSkip(`no reachable migrated database (${error instanceof Error ? error.message : String(error)})`);
    await db.destroy().catch(() => {});
    return null;
  }
}

const db = await connectOrSkip();

// --- fixture -------------------------------------------------------------

/** One run id per suite run so a crashed run can never collide with the next. */
const RUN = ulid();

const R1 = `rec-enrich-1-${RUN}`; // gets both dimensions' labels
const R2 = `rec-enrich-2-${RUN}`; // never enriched — no recipe_enrichment row
const R3 = `rec-enrich-3-${RUN}`; // enrichment row exists, no labels yet, and a failed run
const R4 = `rec-enrich-4-${RUN}`; // sparse: one stored label out of a much larger vocab
const RECIPES = [R1, R2, R3, R4];

type RecipeEnrichment = typeof import("./recipe-enrichment");
let mod: RecipeEnrichment;

async function cleanup(): Promise<void> {
  if (!db) return;
  await db.deleteFrom("recipe_enrichment_label").where("recipe_id", "in", RECIPES).execute();
  await db.deleteFrom("recipe_enrichment").where("recipe_id", "in", RECIPES).execute();
  await db.deleteFrom("recipe").where("id", "in", RECIPES).execute();
}

async function reset(): Promise<void> {
  if (!db) return;
  await cleanup();

  await db
    .insertInto("recipe")
    .values([
      { id: R1, origin: "local", visibility: "private", name: "Fish Sauce Pad Thai" },
      { id: R2, origin: "local", visibility: "private", name: "Never Enriched" },
      { id: R3, origin: "local", visibility: "private", name: "Enriched, No Labels Yet" },
      { id: R4, origin: "local", visibility: "private", name: "Sparsely Labeled Toast" },
    ])
    .execute();
}

if (db) {
  mod = await import("./recipe-enrichment");
  beforeEach(reset);
  afterAll(async () => {
    await cleanup();
    await db.destroy();
  });
}

const describeDb = db ? describe : describe.skip;

describeDb("getRecipeEnrichment (§10)", () => {
  it("groups labels by dimension and round-trips numeric/jsonb/timestamp shapes", async () => {
    await db!
      .insertInto("recipe_enrichment")
      .values({ recipe_id: R1, status: "ok", classifier_version: 3, input_hash: "sha256:abc", enriched_at: sql`now()` })
      .execute();

    await db!
      .insertInto("recipe_enrichment_label")
      .values([
        {
          recipe_id: R1,
          dimension: "allergen",
          slug: "fish",
          verdict: "contains",
          confidence: 0.92,
          method: "rules@1",
          evidence: JSON.stringify([{ line: "2 tbsp fish sauce", rule: "lexicon-match" }]),
        },
        { recipe_id: R1, dimension: "allergen", slug: "tree_nuts", verdict: "not_detected", confidence: 0.6, method: "rules@1", evidence: null },
        {
          recipe_id: R1,
          dimension: "diet",
          slug: "vegetarian",
          verdict: "excluded",
          confidence: 0.95,
          method: "rules@1",
          evidence: JSON.stringify([{ line: "2 tbsp fish sauce", rule: "non-vegetarian-ingredient" }]),
        },
        { recipe_id: R1, dimension: "diet", slug: "pescatarian", verdict: "likely", confidence: 0.8, method: "rules@1", evidence: null },
      ])
      .execute();

    const result = await mod.getRecipeEnrichment(db!, R1);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result).toMatchObject({ recipeId: R1, status: "ok", classifierVersion: 3, inputHash: "sha256:abc", error: null });
    expect(result.enrichedAt).not.toBeNull();
    expect(Object.keys(result.labels).sort()).toEqual(["allergen", "diet"]);

    expect(result.labels.allergen).toHaveLength(2);
    expect(result.labels.diet).toHaveLength(2);

    // Grouping preserves the row shape, including confidence coerced from the
    // pg driver's numeric-as-string back to a real number, and evidence
    // round-tripping through jsonb untouched.
    const fish = result.labels.allergen.find((l) => l.slug === "fish");
    expect(fish).toMatchObject({ dimension: "allergen", slug: "fish", verdict: "contains", confidence: 0.92, method: "rules@1" });
    expect(fish?.evidence).toEqual([{ line: "2 tbsp fish sauce", rule: "lexicon-match" }]);

    const treeNuts = result.labels.allergen.find((l) => l.slug === "tree_nuts");
    expect(treeNuts).toMatchObject({ verdict: "not_detected", confidence: 0.6 });
    expect(treeNuts?.evidence).toBeNull();

    const vegetarian = result.labels.diet.find((l) => l.slug === "vegetarian");
    expect(vegetarian).toMatchObject({ verdict: "excluded", confidence: 0.95 });

    const pescatarian = result.labels.diet.find((l) => l.slug === "pescatarian");
    expect(pescatarian).toMatchObject({ verdict: "likely", confidence: 0.8 });
  });

  it("returns null for a recipe with no recipe_enrichment row — nothing has run yet", async () => {
    expect(await mod.getRecipeEnrichment(db!, R2)).toBeNull();
  });

  it("returns an empty labels object (not undefined) for an enriched-but-labelless row, and carries a failure message through untouched", async () => {
    await db!.insertInto("recipe_enrichment").values({ recipe_id: R3, status: "error", classifier_version: 1, error: "categorizeWith threw: lexicon not loaded" }).execute();

    const result = await mod.getRecipeEnrichment(db!, R3);
    expect(result).toMatchObject({
      recipeId: R3,
      status: "error",
      classifierVersion: 1,
      error: "categorizeWith threw: lexicon not loaded",
      enrichedAt: null,
      labels: {},
    });
  });

  // --- sparse labels: absence is a verdict, not synthesized here -----------
  // (recipe-enrichment.ts's module doc: "pass through sparse", not
  // materialize — the caller applies `SPARSE_LABEL_DEFAULT` itself.)
  it("reads a sparsely-labeled recipe back as exactly the rows stored — nothing synthesized for the rest of recipe_vocab", async () => {
    // The vocab this recipe's dimensions COULD have a row for, if the
    // classifier had found something to say. Confirms the fixture below really
    // is sparse relative to the live schema, not just relative to a guess.
    const vocabCounts = await db!
      .selectFrom("recipe_vocab")
      .select(["dimension", (eb) => eb.fn.countAll().as("n")])
      .groupBy("dimension")
      .execute();
    const allergenVocabCount = Number(vocabCounts.find((r) => r.dimension === "allergen")?.n ?? 0);
    const dietVocabCount = Number(vocabCounts.find((r) => r.dimension === "diet")?.n ?? 0);
    expect(allergenVocabCount).toBeGreaterThan(1);
    expect(dietVocabCount).toBeGreaterThan(0);

    await db!
      .insertInto("recipe_enrichment")
      .values({ recipe_id: R4, status: "ok", classifier_version: 3, enriched_at: sql`now()` })
      .execute();

    // ONE stored label, full stop — everything else (every other allergen
    // slug, every diet slug) is absent on purpose: the classifier evaluated
    // them and found nothing worth a row.
    await db!
      .insertInto("recipe_enrichment_label")
      .values({ recipe_id: R4, dimension: "allergen", slug: "peanut", verdict: "contains", confidence: 0.9, method: "rules@1", evidence: null })
      .execute();

    const result = await mod.getRecipeEnrichment(db!, R4);
    expect(result).not.toBeNull();
    if (!result) return;

    // No `diet` key at all — not an empty array, ABSENT — because zero diet
    // rows were written, and this module does not fill dimensions in.
    expect(Object.keys(result.labels)).toEqual(["allergen"]);
    expect(result.labels.allergen).toHaveLength(1);
    expect(result.labels.allergen).toEqual([expect.objectContaining({ slug: "peanut", verdict: "contains" })]);

    // The one stored row is far fewer than the full vocab this recipe's
    // classifier_version could have written a row for — sparse in fact, not
    // just in name.
    expect(result.labels.allergen.length).toBeLessThan(allergenVocabCount);
  });

  it("SPARSE_LABEL_DEFAULT documents what an absent row means, per dimension", () => {
    expect(mod.SPARSE_LABEL_DEFAULT).toEqual({ allergen: "not_detected", diet: "not excluded" });
  });
});
