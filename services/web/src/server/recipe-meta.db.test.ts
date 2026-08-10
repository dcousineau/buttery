import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "#/db/types";
import { ulid } from "./household/ids";

/**
 * DB-backed integration tests for the Buttery-only metadata sidecar — the §5.4
 * access helpers and the dedupe keys `persistRecipeDraft` writes (§6.6 writer 1).
 *
 * These need a real Postgres with the migrations applied; everything worth
 * asserting here is something a unit test cannot see — the composite primary
 * keys the upserts depend on, `jsonb` round-tripping, `updated_at` actually
 * moving on conflict, the dedupe rows landing in the SAME transaction as the
 * recipe, and the index shape of §5.1/§5.2 accepting an 8 kB value.
 *
 *   pnpm test:db      # railway run --service buttery -- vitest run --project db
 *
 * With no reachable database the suite SKIPS rather than fails, so `pnpm test`
 * stays green on a machine that has never booted the stack.
 */

// --- reachability probe --------------------------------------------------

function announceSkip(reason: string): void {
  process.stderr.write(`\nSKIPPING recipe-meta DB tests — ${reason}.\nRun them against the local dev stack with \`pnpm test:db\` (railway run injects DATABASE_URL).\n\n`);
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
      sql`select 1 from recipe_meta limit 0`.execute(db),
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

/** One namespace per run so a crashed run can never collide with the next. */
const RUN = ulid();

const HH = `hh-meta-${RUN}`;
const DID = `did:test:meta-${RUN}`;
const R1 = `rec-meta-1-${RUN}`;
const R2 = `rec-meta-2-${RUN}`;
const RECIPES = [R1, R2];

// Loaded lazily so a skipped run never imports the server modules at all.
type RecipeMeta = typeof import("./recipe-meta");
type RecipesWrite = typeof import("./recipes-write");
let meta: RecipeMeta;
let write: RecipesWrite;

/** Recipes created by `persistRecipeDraft` get ULIDs we don't know up front. */
const created: string[] = [];

async function cleanup(): Promise<void> {
  if (!db) return;
  const ids = [...RECIPES, ...created];
  await db.deleteFrom("household_recipe_meta").where("household_id", "=", HH).execute();
  await db.deleteFrom("recipe_meta").where("recipe_id", "in", ids).execute();
  await db.deleteFrom("household_recipe").where("household_id", "=", HH).execute();
  await db.deleteFrom("recipe_search").where("recipe_id", "in", ids).execute();
  await db.deleteFrom("recipe_ingredient").where("recipe_id", "in", ids).execute();
  await db.deleteFrom("recipe_instruction").where("recipe_id", "in", ids).execute();
  await db.deleteFrom("recipe_keyword").where("recipe_id", "in", ids).execute();
  await db.deleteFrom("recipe_attribution").where("recipe_id", "in", ids).execute();
  await db.deleteFrom("recipe").where("id", "in", ids).execute();
  await db.deleteFrom("household_member").where("household_id", "=", HH).execute();
  await db.deleteFrom("household").where("id", "=", HH).execute();
}

async function reset(): Promise<void> {
  if (!db) return;
  await cleanup();
  created.length = 0;

  await db
    .insertInto("household")
    .values({ id: HH, name: `meta ${RUN}`, created_by_did: DID })
    .execute();
  await db.insertInto("household_member").values({ household_id: HH, did: DID, role: "owner" }).execute();
  await db
    .insertInto("recipe")
    .values([
      { id: R1, origin: "local", visibility: "private", name: "Shakshuka" },
      { id: R2, origin: "local", visibility: "private", name: "Dal Tadka" },
    ])
    .execute();
}

if (db) {
  meta = await import("./recipe-meta");
  write = await import("./recipes-write");
  beforeEach(reset);
  afterAll(async () => {
    await cleanup();
    await db.destroy();
  });
}

/** A `recipe_meta` namespace read straight from the table, `updated_at` included. */
async function rawRecipeMeta(recipeId: string, ns: string) {
  return db!.selectFrom("recipe_meta").select(["key", "value", "updated_at"]).where("recipe_id", "=", recipeId).where("ns", "=", ns).orderBy("key").execute();
}

const describeDb = db ? describe : describe.skip;

describeDb("recipe_meta helpers (§5.4)", () => {
  it("round-trips every JSON shape and reads back only the asked-for namespace", async () => {
    await meta.setRecipeMeta(db!, R1, "dedupe", { source_url_key: "https://smittenkitchen.com/x", content_fp: "sha256:abc" });
    await meta.setRecipeMeta(db!, R1, "llm.enhance", { tried: true, score: 0.5, tags: ["a", "b"], nothing: null, nested: { k: "v" } });

    expect(await meta.getRecipeMeta(db!, R1, "dedupe")).toEqual({ source_url_key: "https://smittenkitchen.com/x", content_fp: "sha256:abc" });
    expect(await meta.getRecipeMeta(db!, R1, "llm.enhance")).toEqual({ tried: true, score: 0.5, tags: ["a", "b"], nothing: null, nested: { k: "v" } });
    expect(await meta.getRecipeMeta(db!, R1, "absent")).toEqual({});
    expect(await meta.getRecipeMeta(db!, R2, "dedupe")).toEqual({});
  });

  it("upserts: an existing key takes the new value and a fresh updated_at, untouched keys stay", async () => {
    await meta.setRecipeMeta(db!, R1, "dedupe", { content_fp: "sha256:old", source_url_key: "https://a.example/x" });
    const before = await rawRecipeMeta(R1, "dedupe");

    await meta.setRecipeMeta(db!, R1, "dedupe", { content_fp: "sha256:new" });
    const after = await rawRecipeMeta(R1, "dedupe");

    expect(Object.fromEntries(after.map((r) => [r.key, r.value]))).toEqual({ content_fp: "sha256:new", source_url_key: "https://a.example/x" });
    // The rewritten key moved; the one this call never mentioned did not.
    const at = (rows: typeof before, key: string) => rows.find((r) => r.key === key)!.updated_at.valueOf();
    expect(at(after, "content_fp")).toBeGreaterThanOrEqual(at(before, "content_fp"));
    expect(at(after, "source_url_key")).toEqual(at(before, "source_url_key"));
  });

  it("writes many recipes' keys in ONE statement", async () => {
    await meta.setManyRecipeMeta(db!, [
      { recipeId: R1, ns: "dedupe", entries: { content_fp: "sha256:one" } },
      { recipeId: R2, ns: "dedupe", entries: { content_fp: "sha256:two", source_url_key: "https://b.example/y" } },
    ]);
    expect(await meta.getRecipeMeta(db!, R1, "dedupe")).toEqual({ content_fp: "sha256:one" });
    expect(await meta.getRecipeMeta(db!, R2, "dedupe")).toEqual({ content_fp: "sha256:two", source_url_key: "https://b.example/y" });
  });

  it("is a no-op on an empty entry set rather than an invalid empty INSERT", async () => {
    await expect(meta.setRecipeMeta(db!, R1, "dedupe", {})).resolves.toBeUndefined();
    await expect(meta.setManyRecipeMeta(db!, [])).resolves.toBeUndefined();
    expect(await meta.getRecipeMeta(db!, R1, "dedupe")).toEqual({});
  });
});

describeDb("household_recipe_meta helpers (§5.4)", () => {
  it("scopes reads to one (household, recipe) pair", async () => {
    await meta.setHouseholdRecipeMeta(db!, HH, R1, "import", { importer: "paprika", session_id: "s1" });
    expect(await meta.getHouseholdRecipeMeta(db!, HH, R1, "import")).toEqual({ importer: "paprika", session_id: "s1" });
    expect(await meta.getHouseholdRecipeMeta(db!, HH, R2, "import")).toEqual({});
  });

  it("batches a whole chunk's keys into one statement and upserts on replay", async () => {
    const rows = [
      { recipeId: R1, ns: "import", entries: { importer: "paprika", session_id: "s1", entry_name: "a.html", source_text: "Ottolenghi Simple pg 174", rating: 4 } },
      { recipeId: R2, ns: "import", entries: { importer: "paprika", session_id: "s1", entry_name: "b.html", source_text: "", rating: 0 } },
    ];
    await meta.setManyHouseholdRecipeMeta(db!, HH, rows);
    await meta.setManyHouseholdRecipeMeta(db!, HH, rows); // chunk replay is a no-op

    const count = await db!
      .selectFrom("household_recipe_meta")
      .select(sql<number>`count(*)::int`.as("n"))
      .where("household_id", "=", HH)
      .executeTakeFirstOrThrow();
    expect(count.n).toBe(10);
    expect(await meta.getHouseholdRecipeMeta(db!, HH, R1, "import")).toMatchObject({ importer: "paprika", rating: 4 });
  });

  /**
   * Regression test for the index shape of §5.1/§5.2 (D37). Put `value` back
   * into the generic B-tree and this fails with `index row size … exceeds btree
   * maximum` — at INSERT time, on an in-spec write.
   */
  it("accepts a value at the 8 kB commit-boundary cap", async () => {
    const raw = { blob: "x".repeat(8 * 1024) };
    await expect(meta.setHouseholdRecipeMeta(db!, HH, R1, "import", { raw })).resolves.toBeUndefined();
    expect(await meta.getHouseholdRecipeMeta(db!, HH, R1, "import")).toEqual({ raw });
  });
});

describeDb("persistRecipeDraft writes the dedupe keys (§6.6 writer 1)", () => {
  const draft = { name: "Roast Chicken", text: "", ingredients: ["1 chicken", "Salt"], instructions: ["Roast it."] };

  /** `resolveAttribution` returns null for a caller that must be rejected; every call here supplies enough to succeed. */
  type Choice = Parameters<RecipesWrite["resolveAttribution"]>[2];
  const attributionFor = (sourceUrl: string | null, choice?: Choice) => write.resolveAttribution(draft, sourceUrl, choice)!;

  it("stores both keys, computed from the record, in the same transaction as the recipe", async () => {
    const result = await write.persistRecipeDraft(
      db!,
      { did: DID, householdId: HH },
      {
        record: draft,
        attribution: attributionFor("https://www.Smitten-Kitchen.com/roast/?utm_source=nl"),
        sourceUrl: "https://www.Smitten-Kitchen.com/roast/?utm_source=nl",
        visibility: "private",
      },
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    created.push(result.recipeId);

    const { normalizeSourceUrl, contentFingerprint } = await import("@buttery/recipe-schemas/normalize");
    expect(await meta.getRecipeMeta(db!, result.recipeId, "dedupe")).toEqual({
      source_url_key: normalizeSourceUrl("https://www.Smitten-Kitchen.com/roast/?utm_source=nl"),
      content_fp: await contentFingerprint(draft.name, draft.ingredients),
    });
  });

  it("writes no source_url_key row when there is no source URL", async () => {
    const result = await write.persistRecipeDraft(
      db!,
      { did: DID, householdId: HH },
      {
        record: draft,
        attribution: attributionFor(null, { kind: "publication", title: "Ottolenghi Simple", author: "Yotam Ottolenghi" }),
        sourceUrl: null,
        visibility: "private",
      },
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    created.push(result.recipeId);

    const keys = await meta.getRecipeMeta(db!, result.recipeId, "dedupe");
    expect(Object.keys(keys)).toEqual(["content_fp"]);
  });

  it("rolls the keys back with the recipe when the caller's transaction aborts", async () => {
    let recipeId = "";
    await expect(
      db!.transaction().execute(async (trx) => {
        const result = await write.persistRecipeDraft(
          trx,
          { did: DID, householdId: HH },
          { record: draft, attribution: attributionFor("https://c.example/x"), sourceUrl: "https://c.example/x", visibility: "private" },
        );
        if (result.status !== "ok") throw new Error("expected ok");
        recipeId = result.recipeId;
        throw new Error("caller aborts the chunk");
      }),
    ).rejects.toThrow("caller aborts the chunk");

    expect(await meta.getRecipeMeta(db!, recipeId, "dedupe")).toEqual({});
    expect(await db!.selectFrom("recipe").select("id").where("id", "=", recipeId).executeTakeFirst()).toBeUndefined();
  });

  it("neither publishes nor leaves a uri behind", async () => {
    const result = await write.persistRecipeDraft(
      db!,
      { did: DID, householdId: HH },
      { record: draft, attribution: attributionFor("https://d.example/x"), sourceUrl: "https://d.example/x", visibility: "private" },
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    created.push(result.recipeId);

    const row = await db!.selectFrom("recipe").select(["uri", "visibility"]).where("id", "=", result.recipeId).executeTakeFirstOrThrow();
    expect(row).toEqual({ uri: null, visibility: "private" });
  });
});
