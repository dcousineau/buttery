import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CLASSIFIER_VERSION } from "@buttery/food/classify";
import type { DB } from "#/db/types";
import { ulid } from "./household/ids";

/**
 * DB-backed integration tests for `getRecipeDebug` (the recipe devtools panel's
 * server read surface) — the things a unit test cannot see: the real dedupe-key
 * self-join across `recipe_meta`, the household scoping on shared rendered
 * recipes, the box-check `found: false` gate, and jsonb/timestamptz round-
 * tripping through the `pg` driver.
 *
 *   pnpm --filter @buttery/web exec vitest run --project db
 *
 * With no reachable database the suite SKIPS rather than fails, so `pnpm test`
 * stays green on a machine that has never booted the stack (AGENTS.md).
 */

// --- reachability probe --------------------------------------------------

function announceSkip(reason: string): void {
  process.stderr.write(`\nSKIPPING recipe-debug DB tests — ${reason}.\nRun them against the local dev stack with \`pnpm --filter @buttery/web exec vitest run --project db\`.\n\n`);
}

async function connectOrSkip(): Promise<Kysely<DB> | null> {
  if (!process.env.DATABASE_URL) {
    announceSkip("DATABASE_URL is not set");
    return null;
  }
  const { getDb } = await import("#/lib/db");
  const db = getDb();
  try {
    await Promise.race([sql`select 1 from recipe limit 0`.execute(db), new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 5s")), 5_000).unref?.())]);
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

const HH = `hh-debug-1-${RUN}`; // the caller's household
const HH2 = `hh-debug-2-${RUN}`; // a household the caller is NOT a member of
const HOUSEHOLDS = [HH, HH2];
const DID = `did:test:debug-1-${RUN}`;
const DID2 = `did:test:debug-2-${RUN}`;
const AUTHOR_DID = `did:test:debug-author-${RUN}`;

const R_PUB = `rec-debug-pub-${RUN}`; // published: has did/rkey + a matching atproto_collection_recipe row
const R_PRIV = `rec-debug-priv-${RUN}`; // unpublished local draft, boxed in HH, every private layer populated
const R_COUNTERPART = `rec-debug-counterpart-${RUN}`; // shares R_PRIV's content_fp, boxed only in HH2
const R_SHARED = `rec-debug-shared-${RUN}`; // boxed in BOTH households — the leak-check fixture
const R_FOREIGN = `rec-debug-foreign-${RUN}`; // exists, but boxed only in HH2 — "foreign id" for HH
const R_KEYWORDS = `rec-debug-keywords-${RUN}`; // 205 recipe_keyword rows — the truncation fixture
const R_LLM = `rec-debug-llm-${RUN}`; // recipe_enrichment with BOTH a rules-owned and an llm-owned label — the LLM highlight fixture
const R_UNKNOWN = `rec-debug-unknown-${RUN}`; // never inserted at all

const RECIPES = [R_PUB, R_PRIV, R_COUNTERPART, R_SHARED, R_FOREIGN, R_KEYWORDS, R_LLM];

const SESSION_ID = `import-session-${RUN}`;

type RecipeDebug = typeof import("./recipe-debug");
type RecipeMeta = typeof import("./recipe-meta");
let mod: RecipeDebug;
let meta: RecipeMeta;

async function cleanup(): Promise<void> {
  if (!db) return;
  await db.deleteFrom("recipe_import_attempt").where("household_id", "in", HOUSEHOLDS).execute();
  await db.deleteFrom("recipe_import_session").where("household_id", "in", HOUSEHOLDS).execute();
  await db.deleteFrom("meal_plan_entry").where("household_id", "in", HOUSEHOLDS).execute();
  await db.deleteFrom("recipe_collection").where("household_id", "in", HOUSEHOLDS).execute();
  await db.deleteFrom("household_recipe").where("household_id", "in", HOUSEHOLDS).execute(); // cascades household_recipe_note
  await db.deleteFrom("recipe_pending_image").where("recipe_id", "in", RECIPES).execute();
  await db.deleteFrom("recipe_enrichment_label").where("recipe_id", "in", RECIPES).execute();
  await db.deleteFrom("recipe_enrichment").where("recipe_id", "in", RECIPES).execute();
  await db.deleteFrom("recipe_meta").where("recipe_id", "in", RECIPES).execute();
  await db.deleteFrom("atproto_collection_recipe").where("did", "=", AUTHOR_DID).execute();
  await db.deleteFrom("recipe").where("id", "in", RECIPES).execute(); // cascades ingredient/instruction/keyword/attribution/image/search
  await db.deleteFrom("household_member").where("household_id", "in", HOUSEHOLDS).execute();
  await db.deleteFrom("household").where("id", "in", HOUSEHOLDS).execute();
}

async function reset(): Promise<void> {
  if (!db) return;
  await cleanup();

  await db
    .insertInto("household")
    .values([
      { id: HH, name: `debug hh1 ${RUN}`, created_by_did: DID },
      { id: HH2, name: `debug hh2 ${RUN}`, created_by_did: DID2 },
    ])
    .execute();
  await db
    .insertInto("household_member")
    .values([
      { household_id: HH, did: DID, role: "owner" },
      { household_id: HH2, did: DID2, role: "owner" },
    ])
    .execute();

  await db
    .insertInto("recipe")
    .values([
      {
        id: R_PUB,
        origin: "local",
        visibility: "public",
        name: "Published Fixture",
        did: AUTHOR_DID,
        rkey: R_PUB,
        uri: `at://${AUTHOR_DID}/exchange.recipe.recipe/${R_PUB}`,
        cid: "bafy-pub-cid",
        rev: "rev-1",
        published_at: sql`now()`,
      },
      { id: R_PRIV, origin: "local", visibility: "private", name: "Private Fixture" },
      { id: R_COUNTERPART, origin: "local", visibility: "private", name: "Counterpart Fixture" },
      { id: R_SHARED, origin: "local", visibility: "private", name: "Shared Fixture" },
      { id: R_FOREIGN, origin: "local", visibility: "private", name: "Foreign Fixture" },
      { id: R_KEYWORDS, origin: "local", visibility: "private", name: "Keyword Fixture" },
      { id: R_LLM, origin: "local", visibility: "private", name: "LLM Highlight Fixture" },
    ])
    .execute();

  await db
    .insertInto("atproto_collection_recipe")
    .values({
      did: AUTHOR_DID,
      rkey: R_PUB,
      uri: `at://${AUTHOR_DID}/exchange.recipe.recipe/${R_PUB}`,
      cid: "bafy-pub-cid",
      rev: "rev-1",
      record: JSON.stringify({
        $type: "exchange.recipe.recipe",
        name: "Published Fixture",
        ingredients: ["1 cup flour"],
        instructions: ["Mix it."],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      name: "Published Fixture",
      validation_status: "valid",
    })
    .execute();

  // --- boxing -------------------------------------------------------------
  await db
    .insertInto("household_recipe")
    .values([
      { household_id: HH, recipe_id: R_PUB, added_by_did: DID },
      { household_id: HH, recipe_id: R_PRIV, added_by_did: DID, favorite: true },
      { household_id: HH2, recipe_id: R_COUNTERPART, added_by_did: DID2 },
      { household_id: HH, recipe_id: R_SHARED, added_by_did: DID },
      { household_id: HH2, recipe_id: R_SHARED, added_by_did: DID2 },
      { household_id: HH2, recipe_id: R_FOREIGN, added_by_did: DID2 },
      { household_id: HH, recipe_id: R_KEYWORDS, added_by_did: DID },
      { household_id: HH, recipe_id: R_LLM, added_by_did: DID },
    ])
    .execute();

  // --- R_PRIV: every private layer -----------------------------------------
  await db
    .insertInto("recipe_attribution")
    .values({
      recipe_id: R_PRIV,
      kind: "website",
      display_name: "Example Test",
      author: null,
      publisher: null,
      url: "https://example.test/priv-recipe",
      license: null,
      raw: JSON.stringify({}),
    })
    .execute();

  await db
    .insertInto("recipe_enrichment")
    .values({ recipe_id: R_PRIV, status: "ok", classifier_version: 1, enriched_at: sql`now()` })
    .execute();
  await db
    .insertInto("recipe_enrichment_label")
    .values([
      { recipe_id: R_PRIV, dimension: "allergen", slug: "tree_nuts", verdict: "not_detected", confidence: 0.5, method: "rules@1", evidence: null },
      { recipe_id: R_PRIV, dimension: "diet", slug: "vegetarian", verdict: "excluded", confidence: 0.9, method: "rules@1", evidence: null },
    ])
    .execute();

  await meta.setRecipeMeta(db, R_PRIV, "dedupe", { content_fp: "sha256:shared-fp", source_url_key: "example.test/priv-recipe" });
  await meta.setRecipeMeta(db, R_COUNTERPART, "dedupe", { content_fp: "sha256:shared-fp" });

  await db.insertInto("household_recipe_note").values({ household_id: HH, recipe_id: R_PRIV, author_did: DID, body: "Freeze the leftovers." }).execute();
  // The leak-check note: attached to R_SHARED, but in HH2 — HH's debug read must never surface it.
  await db.insertInto("household_recipe_note").values({ household_id: HH2, recipe_id: R_SHARED, author_did: DID2, body: "HH2's private note — must not leak to HH." }).execute();
  await db.insertInto("household_recipe_note").values({ household_id: HH, recipe_id: R_SHARED, author_did: DID, body: "HH's own note on the shared recipe." }).execute();

  const collectionId = ulid();
  await db.insertInto("recipe_collection").values({ id: collectionId, household_id: HH, name: "Weeknight Dinners", position: 0, created_by_did: DID }).execute();
  await db.insertInto("recipe_collection_entry").values({ collection_id: collectionId, household_id: HH, recipe_id: R_PRIV, position: 0, added_by_did: DID }).execute();

  await db
    .insertInto("meal_plan_entry")
    .values({ id: ulid(), household_id: HH, plan_date: "2026-08-30", slot: "dinner", kind: "recipe", position: 0, recipe_id: R_PRIV, created_by_did: DID })
    .execute();

  await db
    .insertInto("recipe_pending_image")
    .values({ recipe_id: R_PRIV, object_key: `pending/${R_PRIV}`, mime: "image/jpeg", alt: "fixture hero" })
    .execute();

  await meta.setHouseholdRecipeMeta(db, HH, R_PRIV, "import", { importer: "paprika", session_id: SESSION_ID, entry_name: "Private Fixture.html" });
  await db.insertInto("recipe_import_session").values({ id: SESSION_ID, household_id: HH, did: DID, importer: "paprika", status: "complete" }).execute();
  await db
    .insertInto("recipe_import_attempt")
    .values({ id: ulid(), did: DID, household_id: HH, url: "https://example.test/priv-recipe", host: "example.test", status: "success", source: "scrape" })
    .execute();

  // --- R_KEYWORDS: 205 rows to force truncation ----------------------------
  await db
    .insertInto("recipe_keyword")
    .values(Array.from({ length: 205 }, (_, i) => ({ recipe_id: R_KEYWORDS, keyword: `kw-${String(i).padStart(3, "0")}` })))
    .execute();

  // --- R_LLM: the LLM highlight fixture ------------------------------------
  // `classifier_version` is set to the ACTUAL deployed `CLASSIFIER_VERSION`
  // (imported above) rather than a hardcoded number, so `rulesVersionCurrent`
  // reads `true` regardless of future version bumps — the point of this
  // fixture is to exercise the "fresh, current, ok" happy path, not to pin a
  // version number that will drift out from under the test.
  await db
    .insertInto("recipe_enrichment")
    .values({
      recipe_id: R_LLM,
      status: "ok",
      classifier_version: CLASSIFIER_VERSION,
      input_hash: "sha256:llm-fixture-hash",
      enriched_at: sql`now()`,
      llm_status: "ok",
      llm_version: 1,
      llm_input_hash: "sha256:llm-fixture-hash", // matches input_hash — freshAgainstRules should read true
      llm_model: "openrouter:mistral-test",
      llm_prompt_version: null, // the fallback-prompt case (llm/prompt.ts ran, not "unknown")
      llm_enriched_at: sql`now()`,
    })
    .execute();
  await db
    .insertInto("recipe_enrichment_label")
    .values([
      // Rules-owned: method has no `llm:` prefix.
      { recipe_id: R_LLM, dimension: "allergen", slug: "tree_nuts", verdict: "not_detected", confidence: 0.4, method: `rules@${CLASSIFIER_VERSION}`, evidence: null },
      // LLM-owned: an LLM-only dimension (cuisine) the rules classifier never emits at all.
      { recipe_id: R_LLM, dimension: "cuisine", slug: "italian", verdict: "likely", confidence: 0.82, method: "llm:openrouter:mistral-test@v1", evidence: null },
    ])
    .execute();
}

if (db) {
  mod = await import("./recipe-debug");
  meta = await import("./recipe-meta");
  beforeEach(reset);
  afterAll(async () => {
    await cleanup();
    await db.destroy();
  });
}

const describeDb = db ? describe : describe.skip;

describeDb("getRecipeDebug", () => {
  it("returns found:false for an id that was never inserted", async () => {
    const result = await mod.getRecipeDebug(db!, HH, R_UNKNOWN);
    expect(result).toEqual({
      recipeId: R_UNKNOWN,
      found: false,
      summary: null,
      atprotoRecord: null,
      counterparts: [],
      llmEnrichment: null,
      rendered: [],
      privateLayers: [],
      warnings: [],
    });
  });

  it("returns found:false for a real recipe boxed only in a different household — a 'foreign id'", async () => {
    const result = await mod.getRecipeDebug(db!, HH, R_FOREIGN);
    expect(result.found).toBe(false);
  });

  it("a published recipe returns a non-null atprotoRecord with the raw record untouched", async () => {
    const result = await mod.getRecipeDebug(db!, HH, R_PUB);
    expect(result.found).toBe(true);
    expect(result.summary).toMatchObject({ name: "Published Fixture", did: AUTHOR_DID, rkey: R_PUB, cid: "bafy-pub-cid", rev: "rev-1" });
    expect(result.atprotoRecord).not.toBeNull();
    expect(result.atprotoRecord).toMatchObject({
      uri: `at://${AUTHOR_DID}/exchange.recipe.recipe/${R_PUB}`,
      cid: "bafy-pub-cid",
      rev: "rev-1",
      validationStatus: "valid",
      deletedAt: null,
    });
    // The raw jsonb, byte-for-byte: $type survives, nothing is reshaped or dropped.
    expect(result.atprotoRecord?.record).toMatchObject({ $type: "exchange.recipe.recipe", name: "Published Fixture", ingredients: ["1 cup flour"], instructions: ["Mix it."] });
    // R_PUB has no recipe_enrichment row at all in this fixture set — nothing
    // has ever classified it, rules or LLM — so the highlight is null rather
    // than a summary full of zeroes/nulls pretending something ran.
    expect(result.llmEnrichment).toBeNull();
  });

  it("an unpublished (local, no did/rkey) recipe returns atprotoRecord: null", async () => {
    const result = await mod.getRecipeDebug(db!, HH, R_PRIV);
    expect(result.found).toBe(true);
    expect(result.atprotoRecord).toBeNull();
    expect(result.warnings.some((w) => w.includes("atproto_collection_recipe"))).toBe(false);
  });

  it("surfaces recipe_enrichment and recipe_enrichment_label in privateLayers, both published:false, with the not_detected caveat in the label section's note", async () => {
    const result = await mod.getRecipeDebug(db!, HH, R_PRIV);
    const enrichment = result.privateLayers.find((s) => s.table === "recipe_enrichment");
    const labels = result.privateLayers.find((s) => s.table === "recipe_enrichment_label");
    expect(enrichment).toMatchObject({ published: false });
    expect(enrichment?.rows).toHaveLength(1);
    expect(labels).toMatchObject({ published: false });
    expect(labels?.rows).toHaveLength(2);
    expect(labels?.note).toMatch(/not a safety claim/i);
  });

  it("surfaces every documented private-layer table, all published:false, and the rendered recipe row/children as published:true", async () => {
    const result = await mod.getRecipeDebug(db!, HH, R_PRIV);
    const tables = result.privateLayers.map((s) => s.table).sort();
    expect(tables).toEqual(
      [
        "household_recipe",
        "household_recipe_meta",
        "household_recipe_note",
        "meal_plan_entry",
        "recipe_collection_entry",
        "recipe_enrichment",
        "recipe_enrichment_label",
        "recipe_import_attempt",
        "recipe_import_session",
        "recipe_meta",
        "recipe_pending_image",
      ].sort(),
    );
    expect(result.privateLayers.every((s) => s.published === false)).toBe(true);

    expect(result.rendered.map((s) => s.table)).toEqual(["recipe", "recipe_ingredient", "recipe_instruction", "recipe_image", "recipe_keyword", "recipe_attribution"]);
    expect(result.rendered.every((s) => s.published === true)).toBe(true);

    const collectionEntry = result.privateLayers.find((s) => s.table === "recipe_collection_entry");
    expect(collectionEntry).toBeDefined();
    expect((collectionEntry!.rows[0] as { collection_name: string }).collection_name).toBe("Weeknight Dinners");

    const householdRecipe = result.privateLayers.find((s) => s.table === "household_recipe");
    expect(householdRecipe?.rows).toHaveLength(1);
    expect((householdRecipe!.rows[0] as { favorite: boolean }).favorite).toBe(true);
  });

  it("recipe_import_session and recipe_import_attempt only appear when the recipe actually has import provenance, and the attempt match is flagged heuristic", async () => {
    const priv = await mod.getRecipeDebug(db!, HH, R_PRIV);
    const session = priv.privateLayers.find((s) => s.table === "recipe_import_session");
    const attempt = priv.privateLayers.find((s) => s.table === "recipe_import_attempt");
    expect(session?.rows).toMatchObject([{ id: SESSION_ID, importer: "paprika" }]);
    expect(attempt?.rows).toHaveLength(1);
    expect(priv.warnings.some((w) => /heuristic/i.test(w))).toBe(true);

    const pub = await mod.getRecipeDebug(db!, HH, R_PUB);
    expect(pub.privateLayers.find((s) => s.table === "recipe_import_session")).toBeUndefined();
    expect(pub.privateLayers.find((s) => s.table === "recipe_import_attempt")).toBeUndefined();
  });

  it("finds a content_fp counterpart in another household, marks it not inBox, and warns that its private layers are withheld", async () => {
    const result = await mod.getRecipeDebug(db!, HH, R_PRIV);
    expect(result.counterparts).toHaveLength(1);
    expect(result.counterparts[0]).toMatchObject({ recipeId: R_COUNTERPART, matchedOn: "content_fp", inBox: false });
    expect(result.warnings.some((w) => /outside your household's box/.test(w))).toBe(true);
  });

  it("never leaks another household's private note on a recipe shared by both households", async () => {
    const result = await mod.getRecipeDebug(db!, HH, R_SHARED);
    const notes = result.privateLayers.find((s) => s.table === "household_recipe_note");
    expect(notes?.rows).toHaveLength(1);
    const bodies = (notes!.rows as { body: string }[]).map((r) => r.body);
    expect(bodies).toEqual(["HH's own note on the shared recipe."]);
    expect(bodies).not.toContain("HH2's private note — must not leak to HH.");
  });

  it("caps a section at 200 rows and names the truncation in warnings", async () => {
    const result = await mod.getRecipeDebug(db!, HH, R_KEYWORDS);
    const keywords = result.rendered.find((s) => s.table === "recipe_keyword");
    expect(keywords?.rows).toHaveLength(200);
    expect(result.warnings.some((w) => w.startsWith("recipe_keyword:") && /capped/.test(w))).toBe(true);
  });

  describe("llmEnrichment highlight", () => {
    it("splits labels by the method column's llm: prefix, reports a null promptVersion as the fallback prompt (not 'unknown'), and reads fresh/current", async () => {
      const result = await mod.getRecipeDebug(db!, HH, R_LLM);
      const llm = result.llmEnrichment;
      expect(llm).not.toBeNull();
      expect(llm).toMatchObject({
        status: "ok",
        error: null,
        model: "openrouter:mistral-test",
        promptVersion: null,
        llmVersion: 1,
        classifierVersion: CLASSIFIER_VERSION,
        rulesStatus: "ok",
        rulesVersionCurrent: true,
        inputHash: "sha256:llm-fixture-hash",
        llmInputHash: "sha256:llm-fixture-hash",
        freshAgainstRules: true,
      });

      // Rules-owned row (no llm: prefix) lands under its own dimension, tagged "rules".
      expect(llm!.labelsByDimension.allergen).toEqual([
        expect.objectContaining({ slug: "tree_nuts", verdict: "not_detected", source: "rules", method: `rules@${CLASSIFIER_VERSION}` }),
      ]);
      // LLM-owned row (llm: prefix) lands under ITS dimension, tagged "llm",
      // with the full provenance string kept verbatim in `method`.
      expect(llm!.labelsByDimension.cuisine).toEqual([expect.objectContaining({ slug: "italian", verdict: "likely", source: "llm", method: "llm:openrouter:mistral-test@v1" })]);

      // The SAME rows are still visible raw, unedited, in the generic
      // privateLayers section — the highlight is a second view, not a
      // second source of truth.
      const rawLabels = result.privateLayers.find((s) => s.table === "recipe_enrichment_label");
      expect(rawLabels?.rows).toHaveLength(2);
    });

    it("recipe_enrichment exists but llm-enrich has never run: status/enrichedAt/model are null, llmVersion is 0, and it is NOT confused with 'never classified at all'", async () => {
      const result = await mod.getRecipeDebug(db!, HH, R_PRIV);
      // R_PRIV's fixture recipe_enrichment row (above) sets only the rules
      // half — no llm_* columns — so this is the "rules ran, LLM never
      // attempted" state, distinct from R_PUB's "nothing ran at all" (llmEnrichment: null).
      expect(result.llmEnrichment).not.toBeNull();
      expect(result.llmEnrichment).toMatchObject({ status: null, enrichedAt: null, model: null, promptVersion: null, llmVersion: 0, freshAgainstRules: false });
      // R_PRIV's two rules@1 labels are both rules-owned — no llm: rows exist for it.
      expect(
        Object.values(result.llmEnrichment!.labelsByDimension)
          .flat()
          .every((l) => l.source === "rules"),
      ).toBe(true);
    });
  });
});
