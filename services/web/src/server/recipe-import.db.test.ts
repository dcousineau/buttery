import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "#/db/types";
import { ulid } from "./household/ids";
import type { CommitItem, FinalizeOutcome, ProbeItem } from "./recipe-import";

/**
 * DB-backed integration tests for the batch-import pipeline (plan §7).
 *
 * Everything asserted here is something a unit test structurally cannot see: the
 * §6.3 verdict precedence depends on three real corpora, §6.4's threshold is
 * Postgres' `similarity()` and not a JS approximation, per-item isolation is a
 * claim about transaction boundaries, and §7.7's counters are *derived by
 * querying* — the whole point being that they cannot drift, which is only
 * observable against real rows.
 *
 *   pnpm test:db      # railway run --service buttery -- vitest run --project db
 *
 * With no reachable database the suite SKIPS rather than fails.
 */

// --- reachability probe --------------------------------------------------

function announceSkip(reason: string): void {
  process.stderr.write(`\nSKIPPING recipe-import DB tests — ${reason}.\nRun them against the local dev stack with \`pnpm test:db\` (railway run injects DATABASE_URL).\n\n`);
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
      sql`select 1 from recipe_import_session limit 0`.execute(db),
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

/** One id space per run so a crashed run can never collide with the next. */
const RUN = ulid();

const HH = `hh-imp-${RUN}`;
const OTHER_HH = `hh-imp-other-${RUN}`;
const DID = `did:test:imp-${RUN}`;
const PUB_DID = `did:test:imp-pub-${RUN}`;

/** In the box, carrying a `source_url_key`. */
const BOX_URL = `rec-imp-boxurl-${RUN}`;
/** In the box, carrying only a `content_fp`. */
const BOX_FP = `rec-imp-boxfp-${RUN}`;
/** In the box AND matching a public record's url key — the precedence case. */
const BOX_BOTH = `rec-imp-boxboth-${RUN}`;
/** Public + indexed, not in this box: the `public_exists` corpus. */
const PUBLIC = `rec-imp-public-${RUN}`;
/** Public copy of the recipe already in the box. */
const PUBLIC_SHADOW = `rec-imp-shadow-${RUN}`;
/** In the box purely as a fuzzy-title target. */
const BOX_TITLE = `rec-imp-title-${RUN}`;
/** Private, and in ANOTHER household's box — the scoping case. */
const PRIVATE_ELSEWHERE = `rec-imp-elsewhere-${RUN}`;
/** Public AND already in this box, but not by this session — the link-refusal case. */
const BOXED_PUBLIC = `rec-imp-boxedpub-${RUN}`;

const FIXTURE_RECIPES = [BOX_URL, BOX_FP, BOX_BOTH, PUBLIC, PUBLIC_SHADOW, BOX_TITLE, PRIVATE_ELSEWHERE, BOXED_PUBLIC];

/**
 * The stored dedupe keys are NORMALIZED source URLs (scheme dropped, `www.`
 * stripped, tracking params removed), because that is what `computeDedupeKeys`
 * writes. Deriving them here rather than hand-writing the normalized form keeps
 * the fixture honest: the commit path recomputes from the raw URL and must land
 * on the same string.
 */
const { normalizeSourceUrl } = await import("@buttery/recipe-schemas/normalize");
const SRC_BOX = `https://boxed.example/${RUN}/one`;
const SRC_BOTH = `https://both.example/${RUN}/two`;
const SRC_PUBLIC = `https://public.example/${RUN}/three`;
const URL_KEY_BOX = normalizeSourceUrl(SRC_BOX)!;
const URL_KEY_BOTH = normalizeSourceUrl(SRC_BOTH)!;
const URL_KEY_PUBLIC = normalizeSourceUrl(SRC_PUBLIC)!;
const FP_BOX = `sha256:boxfp-${RUN}`;

const FUZZY_NAME = "Grandma Wilson's Deep Dish Apple Pie";

// Loaded lazily so a skipped run never imports the server modules at all.
type ImportModule = typeof import("./recipe-import");
let imp: ImportModule;

/** Recipes `persistRecipeDraft` created, whose ULIDs we don't know up front. */
const created: string[] = [];

async function cleanup(): Promise<void> {
  if (!db) return;
  const ids = [...FIXTURE_RECIPES, ...created];
  for (const hh of [HH, OTHER_HH]) {
    await db.deleteFrom("household_recipe_meta").where("household_id", "=", hh).execute();
    await db.deleteFrom("household_recipe_note").where("household_id", "=", hh).execute();
    await db.deleteFrom("household_recipe").where("household_id", "=", hh).execute();
    await db.deleteFrom("recipe_import_session").where("household_id", "=", hh).execute();
    await db.deleteFrom("household_member").where("household_id", "=", hh).execute();
    await db.deleteFrom("household").where("id", "=", hh).execute();
  }
  await db.deleteFrom("recipe_meta").where("recipe_id", "in", ids).execute();
  await db.deleteFrom("recipe_pending_image").where("recipe_id", "in", ids).execute();
  await db.deleteFrom("recipe_search").where("recipe_id", "in", ids).execute();
  await db.deleteFrom("recipe_ingredient").where("recipe_id", "in", ids).execute();
  await db.deleteFrom("recipe_instruction").where("recipe_id", "in", ids).execute();
  await db.deleteFrom("recipe_keyword").where("recipe_id", "in", ids).execute();
  await db.deleteFrom("recipe_attribution").where("recipe_id", "in", ids).execute();
  await db.deleteFrom("recipe").where("id", "in", ids).execute();
  await db.deleteFrom("atproto_repo").where("did", "in", [DID, PUB_DID]).execute();
}

async function reset(): Promise<void> {
  if (!db) return;
  await cleanup();
  created.length = 0;

  await db
    .insertInto("household")
    .values([
      { id: HH, name: `import ${RUN}`, created_by_did: DID },
      { id: OTHER_HH, name: `other ${RUN}`, created_by_did: PUB_DID },
    ])
    .execute();
  await db
    .insertInto("household_member")
    .values([
      { household_id: HH, did: DID, role: "owner" },
      { household_id: OTHER_HH, did: PUB_DID, role: "owner" },
    ])
    .execute();

  // Handles exist for both DIDs so `addedByHandle` is exercised, not just null.
  await db
    .insertInto("atproto_repo")
    .values([
      { did: DID, handle: `importer-${RUN}.test` },
      { did: PUB_DID, handle: `publisher-${RUN}.test` },
    ])
    .execute();

  await db
    .insertInto("recipe")
    .values([
      { id: BOX_URL, origin: "local", visibility: "private", name: "Boxed By Url" },
      { id: BOX_FP, origin: "local", visibility: "private", name: "Boxed By Fingerprint" },
      { id: BOX_BOTH, origin: "local", visibility: "private", name: "Boxed And Also Public" },
      { id: BOX_TITLE, origin: "local", visibility: "private", name: FUZZY_NAME },
      { id: PUBLIC, origin: "sync", visibility: "public", name: "Public Roast Chicken", did: PUB_DID, uri: `at://${PUB_DID}/exchange.recipe.recipe/${RUN}pub` },
      { id: PUBLIC_SHADOW, origin: "sync", visibility: "public", name: "Public Shadow", did: PUB_DID, uri: `at://${PUB_DID}/exchange.recipe.recipe/${RUN}shadow` },
      { id: PRIVATE_ELSEWHERE, origin: "local", visibility: "private", name: "Someone Else's Recipe", did: PUB_DID },
      { id: BOXED_PUBLIC, origin: "sync", visibility: "public", name: "Already Saved", did: PUB_DID, uri: `at://${PUB_DID}/exchange.recipe.recipe/${RUN}saved` },
    ])
    .execute();

  await db
    .insertInto("household_recipe")
    .values([
      { household_id: HH, recipe_id: BOX_URL, added_by_did: DID },
      { household_id: HH, recipe_id: BOX_FP, added_by_did: DID },
      { household_id: HH, recipe_id: BOX_BOTH, added_by_did: DID },
      { household_id: HH, recipe_id: BOX_TITLE, added_by_did: DID },
      { household_id: HH, recipe_id: BOXED_PUBLIC, added_by_did: DID },
      { household_id: OTHER_HH, recipe_id: PRIVATE_ELSEWHERE, added_by_did: PUB_DID },
    ])
    .execute();

  const meta = await import("./recipe-meta");
  await meta.setManyRecipeMeta(db, [
    { recipeId: BOX_URL, ns: "dedupe", entries: { source_url_key: URL_KEY_BOX, content_fp: `sha256:boxurl-${RUN}` } },
    { recipeId: BOX_FP, ns: "dedupe", entries: { content_fp: FP_BOX } },
    { recipeId: BOX_BOTH, ns: "dedupe", entries: { source_url_key: URL_KEY_BOTH, content_fp: `sha256:boxboth-${RUN}` } },
    { recipeId: PUBLIC, ns: "dedupe", entries: { source_url_key: URL_KEY_PUBLIC, content_fp: `sha256:public-${RUN}` } },
    { recipeId: PUBLIC_SHADOW, ns: "dedupe", entries: { source_url_key: URL_KEY_BOTH, content_fp: `sha256:shadow-${RUN}` } },
  ]);
}

if (db) {
  imp = await import("./recipe-import");
  beforeEach(reset);
  afterAll(async () => {
    await cleanup();
    await db.destroy();
  });
}

const describeDb = db ? describe : describe.skip;

// --- helpers -------------------------------------------------------------

async function openSession(): Promise<string> {
  const session = await imp.runOpenImportSession(db!, DID, HH, { importer: "paprika", fileName: "My Recipes", totalCount: 3 });
  return session.sessionId;
}

const probeItem = (over: Partial<ProbeItem> & { clientId: string }): ProbeItem => ({
  sourceUrlKey: null,
  contentFp: `sha256:novel-${over.clientId}-${RUN}`,
  title: `Nothing Like Anything ${over.clientId}`,
  ...over,
});

/** A record shaped like the lexicon input `persistRecipeDraft` accepts. */
const draft = (name: string, ingredients: string[] = ["1 chicken", "Salt"]) => ({ name, text: "", ingredients, instructions: ["Cook it."] });

const importItem = (over: Partial<Extract<CommitItem, { action: "import" }>> & { clientId: string }): CommitItem => ({
  action: "import",
  entryName: `${over.clientId}.html`,
  record: draft(`Imported ${over.clientId} ${RUN}`),
  sourceUrl: `https://source.example/${RUN}/${over.clientId}`,
  attribution: null,
  imageSourceUrl: null,
  notes: null,
  tags: [],
  sourceText: null,
  meta: {},
  ...over,
});

const outcome = (over: Partial<FinalizeOutcome> = {}): FinalizeOutcome => ({
  total: 0,
  imported: 0,
  linked: 0,
  skippedDuplicate: 0,
  skippedUser: 0,
  failed: 0,
  overriddenDuplicate: 0,
  editedBeforeCommit: 0,
  parseFailures: 0,
  distinctSourceStringsClassified: 0,
  ...over,
});

/** Track anything the commit path created so `cleanup` can reach it. */
function track(results: Awaited<ReturnType<ImportModule["runCommitImportChunk"]>>): void {
  for (const r of results) if (r.status === "imported") created.push(r.recipeId);
}

async function similarityOf(a: string, b: string): Promise<number> {
  const row = await sql<{ s: number }>`select similarity(${a}, ${b})::float8 as s`.execute(db!);
  return row.rows[0].s;
}

// --- §7.1 / §6.3 ---------------------------------------------------------

describeDb("probeImportDuplicates verdicts (§6.3)", () => {
  it("returns each of the four corpus verdicts", async () => {
    const sessionId = await openSession();
    const verdicts = await imp.runProbeImportDuplicates(db!, DID, HH, {
      sessionId,
      items: [
        probeItem({ clientId: "url", sourceUrlKey: URL_KEY_BOX }),
        probeItem({ clientId: "fp", contentFp: FP_BOX }),
        probeItem({ clientId: "pub", sourceUrlKey: URL_KEY_PUBLIC }),
        probeItem({ clientId: "fuzzy", title: `${FUZZY_NAME}s` }),
        probeItem({ clientId: "fresh" }),
      ],
    });

    const by = Object.fromEntries(verdicts.map((v) => [v.clientId, v]));
    expect(by.url).toMatchObject({ verdict: "in_box", existing: { recipeId: BOX_URL, name: "Boxed By Url", addedByHandle: `@importer-${RUN}.test` } });
    // A fingerprint match is an in-box duplicate even with no URL on either side.
    expect(by.fp).toMatchObject({ verdict: "in_box", existing: { recipeId: BOX_FP } });
    expect(by.pub).toMatchObject({ verdict: "public_exists", existing: { recipeId: PUBLIC, addedByHandle: `@publisher-${RUN}.test` } });
    expect(by.fuzzy).toMatchObject({ verdict: "maybe" });
    expect(by.fuzzy).toHaveProperty("candidates.0.recipeId", BOX_TITLE);
    expect(by.fresh).toEqual({ clientId: "fresh", verdict: "new" });

    // `addedAt` is an ISO string in every ref the review screen renders (§10.2).
    expect(Date.parse((by.url as { existing: { addedAt: string } }).existing.addedAt)).not.toBeNaN();
  });

  it("reports the second occurrence of a key inside one batch as dupe_in_batch, and the first keeps its corpus verdict", async () => {
    const sessionId = await openSession();
    const verdicts = await imp.runProbeImportDuplicates(db!, DID, HH, {
      sessionId,
      items: [
        probeItem({ clientId: "first", sourceUrlKey: URL_KEY_BOX }),
        probeItem({ clientId: "second", sourceUrlKey: URL_KEY_BOX }),
        // Same fingerprint as `third`, no URL at all: the fp arm of the check.
        probeItem({ clientId: "third", contentFp: `sha256:batch-${RUN}` }),
        probeItem({ clientId: "fourth", contentFp: `sha256:batch-${RUN}` }),
      ],
    });

    const by = Object.fromEntries(verdicts.map((v) => [v.clientId, v]));
    expect(by.first).toMatchObject({ verdict: "in_box" });
    expect(by.second).toEqual({ clientId: "second", verdict: "dupe_in_batch", duplicateOfClientId: "first" });
    expect(by.third).toMatchObject({ verdict: "new" });
    expect(by.fourth).toEqual({ clientId: "fourth", verdict: "dupe_in_batch", duplicateOfClientId: "third" });
  });

  it("prefers in_box over public_exists for a recipe that is both", async () => {
    const sessionId = await openSession();
    const [verdict] = await imp.runProbeImportDuplicates(db!, DID, HH, { sessionId, items: [probeItem({ clientId: "both", sourceUrlKey: URL_KEY_BOTH })] });
    expect(verdict).toMatchObject({ verdict: "in_box", existing: { recipeId: BOX_BOTH } });
  });

  it("prefers a key match over a fuzzy title match", async () => {
    const sessionId = await openSession();
    const [verdict] = await imp.runProbeImportDuplicates(db!, DID, HH, {
      sessionId,
      items: [probeItem({ clientId: "keyed", sourceUrlKey: URL_KEY_BOX, title: `${FUZZY_NAME}s` })],
    });
    expect(verdict).toMatchObject({ verdict: "in_box", existing: { recipeId: BOX_URL } });
  });

  it("advances the session to reviewing without writing anything else", async () => {
    const sessionId = await openSession();
    await imp.runProbeImportDuplicates(db!, DID, HH, { sessionId, items: [probeItem({ clientId: "a" })] });
    const row = await db!.selectFrom("recipe_import_session").select("status").where("id", "=", sessionId).executeTakeFirstOrThrow();
    expect(row.status).toBe("reviewing");
    const boxed = await db!
      .selectFrom("household_recipe")
      .select(sql<number>`count(*)::int`.as("n"))
      .where("household_id", "=", HH)
      .executeTakeFirstOrThrow();
    expect(boxed.n).toBe(5); // exactly the fixtures
  });

  it("refuses a session belonging to another household (§16.17)", async () => {
    const mine = await openSession();
    await expect(imp.runProbeImportDuplicates(db!, PUB_DID, OTHER_HH, { sessionId: mine, items: [] })).rejects.toThrow(/not found/i);
  });
});

// --- §6.4 ----------------------------------------------------------------

describeDb("fuzzy title threshold (§6.4)", () => {
  it("matches above 0.85 and does not match below it", async () => {
    const near = `${FUZZY_NAME}s`; // one trailing character
    const far = "Apple Pie";

    // Sanity: this suite is only meaningful if these really straddle the cut.
    expect(await similarityOf(FUZZY_NAME, near)).toBeGreaterThan(imp.FUZZY_TITLE_THRESHOLD);
    const farScore = await similarityOf(FUZZY_NAME, far);
    expect(farScore).toBeLessThanOrEqual(imp.FUZZY_TITLE_THRESHOLD);
    // …and that the *near-miss* is still similar enough for the `%` prefilter to
    // admit it, so what rejects it is the explicit 0.85 check and nothing else.
    expect(farScore).toBeGreaterThan(0);

    const sessionId = await openSession();
    const verdicts = await imp.runProbeImportDuplicates(db!, DID, HH, {
      sessionId,
      items: [probeItem({ clientId: "above", title: near }), probeItem({ clientId: "below", title: far })],
    });
    const by = Object.fromEntries(verdicts.map((v) => [v.clientId, v]));
    expect(by.above).toMatchObject({ verdict: "maybe" });
    expect(by.below).toEqual({ clientId: "below", verdict: "new" });
  });

  it("never fuzzy-matches another household's recipes", async () => {
    const sessionId = await openSession();
    const [verdict] = await imp.runProbeImportDuplicates(db!, DID, HH, { sessionId, items: [probeItem({ clientId: "x", title: "Someone Else's Recipe" })] });
    expect(verdict).toEqual({ clientId: "x", verdict: "new" });
  });
});

// --- §7.2 meta boundary --------------------------------------------------

describeDb("importer metadata is validated at the boundary (§7.2, §12.5)", () => {
  it("rejects each of the four reserved keys, per item, without failing the chunk", async () => {
    const sessionId = await openSession();
    const results = await imp.runCommitImportChunk(db!, DID, HH, {
      sessionId,
      items: [...imp.RESERVED_META_KEYS.map((key) => importItem({ clientId: `reserved-${key}`, meta: { [key]: "mine" } })), importItem({ clientId: "clean" })],
    });
    track(results);

    for (const key of imp.RESERVED_META_KEYS) {
      const failed = results.find((r) => r.clientId === `reserved-${key}`)!;
      expect(failed.status).toBe("failed");
      expect(failed).toHaveProperty("message", expect.stringContaining(key));
    }
    // The good item in the same chunk still committed (§7.2 per-item isolation).
    expect(results.find((r) => r.clientId === "clean")!.status).toBe("imported");
  });

  it("rejects metadata over 8 kB", async () => {
    const sessionId = await openSession();
    const results = await imp.runCommitImportChunk(db!, DID, HH, {
      sessionId,
      items: [importItem({ clientId: "fat", meta: { blob: "x".repeat(9 * 1024) } })],
    });
    expect(results[0]).toMatchObject({ status: "failed" });
    expect(results[0]).toHaveProperty("message", expect.stringContaining("8192"));
  });

  it("rejects non-object and non-JSON shapes", () => {
    expect(imp.validateItemMeta([1, 2, 3]).ok).toBe(false);
    expect(imp.validateItemMeta("nope").ok).toBe(false);
    expect(imp.validateItemMeta(42).ok).toBe(false);
    expect(imp.validateItemMeta({ fn: () => 1 }).ok).toBe(false);
    expect(imp.validateItemMeta({ n: Number.NaN }).ok).toBe(false);
    expect(imp.validateItemMeta({ big: 1n }).ok).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(imp.validateItemMeta(cyclic).ok).toBe(false);

    // …and accepts the shapes an importer legitimately emits.
    expect(imp.validateItemMeta({ rating: 4, categories: ["Dinner"], nested: { on_favorites: true }, nothing: null })).toEqual({
      ok: true,
      meta: { rating: 4, categories: ["Dinner"], nested: { on_favorites: true }, nothing: null },
    });
    expect(imp.validateItemMeta(undefined)).toEqual({ ok: true, meta: {} });
  });
});

// --- §7.2 commit ---------------------------------------------------------

describeDb("commitImportChunk (§7.2)", () => {
  it("commits an import, a link and a skip in one chunk", async () => {
    const sessionId = await openSession();
    const results = await imp.runCommitImportChunk(db!, DID, HH, {
      sessionId,
      items: [
        importItem({
          clientId: "i",
          record: draft(`Ratatouille ${RUN}`),
          notes: "Halve the salt.",
          tags: ["Dinner", "Weeknight"],
          sourceText: "Ottolenghi Simple, pg 174",
          meta: { rating: 5, categories: ["Dinner"] },
        }),
        { action: "link", clientId: "l", entryName: "l.html", existingRecipeId: PUBLIC, notes: "Grandma's favourite.", sourceText: "grandma", meta: { rating: 3 } },
        { action: "skip", clientId: "s", entryName: "s.html" },
      ],
    });
    track(results);

    const by = Object.fromEntries(results.map((r) => [r.clientId, r]));
    expect(by.i.status).toBe("imported");
    expect(by.l).toEqual({ clientId: "l", status: "linked", recipeId: PUBLIC });
    expect(by.s).toEqual({ clientId: "s", status: "skipped", reason: "user" });

    const recipeId = (by.i as { recipeId: string }).recipeId;

    // §7.4: private, unpublished, no uri — nothing on this path can reach a PDS.
    const row = await db!.selectFrom("recipe").select(["uri", "visibility", "recipe_category"]).where("id", "=", recipeId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ uri: null, visibility: "private" });
    // §12.3: a tag that maps to the controlled category vocabulary fills it in.
    expect(row.recipe_category).toBe("dinner");

    // §12.3: every tag survives as a keyword whether or not it mapped.
    const keywords = await db!.selectFrom("recipe_keyword").select("keyword").where("recipe_id", "=", recipeId).execute();
    expect(keywords.map((k) => k.keyword).sort()).toEqual(["Dinner", "Weeknight"]);

    // §12.2: notes land on the household note, both for imports and links.
    const notes = await db!.selectFrom("household_recipe_note").select(["recipe_id", "body"]).where("household_id", "=", HH).orderBy("recipe_id").execute();
    expect(notes).toEqual(
      expect.arrayContaining([
        { recipe_id: recipeId, body: "Halve the salt." },
        { recipe_id: PUBLIC, body: "Grandma's favourite." },
      ]),
    );

    // §12.5: the four pipeline-owned rows plus the importer's opaque bag.
    const meta = await import("./recipe-meta");
    expect(await meta.getHouseholdRecipeMeta(db!, HH, recipeId, "import")).toEqual({
      importer: "paprika",
      session_id: sessionId,
      entry_name: "i.html",
      source_text: "Ottolenghi Simple, pg 174",
      rating: 5,
      categories: ["Dinner"],
    });

    // The linked recipe is in the box now; the import's own row is there too.
    const boxed = await db!.selectFrom("household_recipe").select("recipe_id").where("household_id", "=", HH).execute();
    expect(boxed.map((b) => b.recipe_id)).toEqual(expect.arrayContaining([PUBLIC, recipeId]));
  });

  it("keeps the source_text row even when the user classified it as something else (§8.2)", async () => {
    const sessionId = await openSession();
    const results = await imp.runCommitImportChunk(db!, DID, HH, {
      sessionId,
      items: [
        importItem({
          clientId: "attr",
          record: draft(`Attributed ${RUN}`),
          sourceUrl: null,
          attribution: { kind: "publication", title: "Ottolenghi Simple", author: "Yotam Ottolenghi" },
          sourceText: "ottolenghi simple pg 174",
        }),
      ],
    });
    track(results);
    expect(results[0].status).toBe("imported");

    const meta = await import("./recipe-meta");
    const recipeId = (results[0] as { recipeId: string }).recipeId;
    expect(await meta.getHouseholdRecipeMeta(db!, HH, recipeId, "import")).toMatchObject({ source_text: "ottolenghi simple pg 174" });
  });

  it("re-checks the household for duplicates at commit time and skips rather than failing", async () => {
    const sessionId = await openSession();
    const results = await imp.runCommitImportChunk(db!, DID, HH, {
      sessionId,
      // Same URL as the recipe already in the box: the probe said `in_box`, and
      // the commit path must reach the same conclusion on its own.
      items: [importItem({ clientId: "dupe", sourceUrl: SRC_BOX })],
    });
    expect(results[0]).toEqual({ clientId: "dupe", status: "skipped", reason: "duplicate" });
  });

  it("imports a known duplicate anyway when the user overrode it (§6.3 D23)", async () => {
    const sessionId = await openSession();
    const results = await imp.runCommitImportChunk(db!, DID, HH, {
      sessionId,
      items: [importItem({ clientId: "over", sourceUrl: SRC_BOX, override: "duplicate" })],
    });
    track(results);
    expect(results[0].status).toBe("imported");
  });

  it("isolates a failing item: the rest of the chunk still commits", async () => {
    const sessionId = await openSession();
    const results = await imp.runCommitImportChunk(db!, DID, HH, {
      sessionId,
      items: [
        importItem({ clientId: "ok1" }),
        // Invalid record: the lexicon caps `name` at 255 characters.
        importItem({ clientId: "bad", record: draft("N".repeat(300)) }),
        importItem({ clientId: "ok2" }),
        // A link to a recipe that is not linkable at all.
        { action: "link", clientId: "badlink", entryName: "b.html", existingRecipeId: PRIVATE_ELSEWHERE, notes: null, sourceText: null, meta: {} },
        importItem({ clientId: "ok3" }),
      ],
    });
    track(results);

    const by = Object.fromEntries(results.map((r) => [r.clientId, r]));
    expect([by.ok1.status, by.ok2.status, by.ok3.status]).toEqual(["imported", "imported", "imported"]);
    expect(by.bad.status).toBe("failed");
    expect(by.badlink).toMatchObject({ status: "failed" });

    // The failures left nothing half-written.
    const boxed = await db!.selectFrom("household_recipe").select("recipe_id").where("household_id", "=", HH).execute();
    expect(boxed.map((b) => b.recipe_id)).not.toContain(PRIVATE_ELSEWHERE);
  });

  it("refuses to link a recipe that is already in the box for another reason", async () => {
    const sessionId = await openSession();
    const results = await imp.runCommitImportChunk(db!, DID, HH, {
      sessionId,
      items: [{ action: "link", clientId: "l", entryName: "l.html", existingRecipeId: BOXED_PUBLIC, notes: null, sourceText: null, meta: {} }],
    });
    expect(results[0]).toMatchObject({ status: "failed", message: expect.stringContaining("already in your box") });
  });

  it("is idempotent on replay: the same chunk twice leaves one of everything (§7.5)", async () => {
    const sessionId = await openSession();
    const items: CommitItem[] = [
      importItem({ clientId: "i", record: draft(`Replayed ${RUN}`), notes: "keep me" }),
      { action: "link", clientId: "l", entryName: "l.html", existingRecipeId: PUBLIC, notes: null, sourceText: null, meta: {} },
      { action: "skip", clientId: "s", entryName: "s.html" },
    ];

    const first = await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items });
    track(first);
    const second = await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items });
    track(second);

    expect(first.map((r) => r.status)).toEqual(["imported", "linked", "skipped"]);
    // The import re-check now sees its own first pass; the link converges.
    expect(second.map((r) => r.status)).toEqual(["skipped", "linked", "skipped"]);
    expect(second[0]).toMatchObject({ reason: "duplicate" });
    expect(second[1]).toMatchObject({ recipeId: PUBLIC });

    const names = await db!
      .selectFrom("recipe")
      .select(sql<number>`count(*)::int`.as("n"))
      .where("name", "=", `Replayed ${RUN}`)
      .executeTakeFirstOrThrow();
    expect(names.n).toBe(1);
  });

  it("refuses a session belonging to another household (§16.17)", async () => {
    const mine = await openSession();
    await expect(imp.runCommitImportChunk(db!, PUB_DID, OTHER_HH, { sessionId: mine, items: [] })).rejects.toThrow(/not found/i);
  });
});

// --- §7.6 ----------------------------------------------------------------

describeDb("getImportComparison (§7.6)", () => {
  it("returns bodies for boxed and public recipes and omits what the caller cannot see", async () => {
    await db!
      .insertInto("recipe_ingredient")
      .values([
        { recipe_id: BOX_URL, ordinal: 0, text: "2 eggs" },
        { recipe_id: BOX_URL, ordinal: 1, text: "1 tin tomatoes" },
        { recipe_id: PUBLIC, ordinal: 0, text: "1 chicken" },
      ])
      .execute();
    await db!
      .insertInto("recipe_instruction")
      .values([{ recipe_id: BOX_URL, ordinal: 0, text: "Fry the tomatoes." }])
      .execute();
    await db!.insertInto("recipe_pending_image").values({ recipe_id: BOX_URL, source_url: "https://img.example/x.jpg" }).execute();

    const sessionId = await openSession();
    const result = await imp.runGetImportComparison(db!, DID, HH, { sessionId, recipeIds: [BOX_URL, PUBLIC, PRIVATE_ELSEWHERE, `rec-missing-${RUN}`] });

    expect(Object.keys(result).sort()).toEqual([BOX_URL, PUBLIC].sort());
    expect(result[BOX_URL]).toMatchObject({
      name: "Boxed By Url",
      hasImage: true,
      ingredients: ["2 eggs", "1 tin tomatoes"],
      instructions: ["Fry the tomatoes."],
      addedByHandle: `@importer-${RUN}.test`,
    });
    expect(result[PUBLIC]).toMatchObject({ name: "Public Roast Chicken", hasImage: false, ingredients: ["1 chicken"], addedByHandle: `@publisher-${RUN}.test` });
    // An unreadable id is absent, not a 403 — the absence is the whole answer.
    expect(result[PRIVATE_ELSEWHERE]).toBeUndefined();
  });
});

// --- §7.7 ----------------------------------------------------------------

describeDb("finalizeImportSession (§7.7)", () => {
  it("derives the counters from rows, and a replayed chunk does not inflate them", async () => {
    const sessionId = await openSession();
    const items: CommitItem[] = [
      importItem({ clientId: "a", record: draft(`Counted A ${RUN}`) }),
      importItem({ clientId: "b", record: draft(`Counted B ${RUN}`) }),
      { action: "link", clientId: "l", entryName: "l.html", existingRecipeId: PUBLIC, notes: null, sourceText: null, meta: {} },
      { action: "skip", clientId: "s", entryName: "s.html" },
    ];
    track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items }));
    track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items })); // lost response, retried

    const result = await imp.runFinalizeImportSession(db!, DID, HH, {
      sessionId,
      outcome: outcome({ total: 4, imported: 2, linked: 1, skippedUser: 1, skippedDuplicate: 0, failed: 0 }),
    });

    expect(result.firstFinalize).toBe(true);
    expect(result.status).toBe("complete");
    // Derived, not accumulated: two chunks, still two imports and one link.
    expect(result.counters).toEqual({ total: 4, imported: 2, linked: 1, skippedDuplicate: 0, skippedUser: 1, failed: 0 });

    const row = await db!.selectFrom("recipe_import_session").selectAll().where("id", "=", sessionId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: "complete", total_count: 4, imported_count: 2, skipped_count: 1, failed_count: 0 });
    expect(row.finished_at).not.toBeNull();
  });

  it("is idempotent: only the first call completes the session", async () => {
    const sessionId = await openSession();
    track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items: [importItem({ clientId: "a", record: draft(`Once ${RUN}`) })] }));

    const first = await imp.runFinalizeImportSession(db!, DID, HH, { sessionId, outcome: outcome({ total: 1, imported: 1 }) });
    const second = await imp.runFinalizeImportSession(db!, DID, HH, { sessionId, outcome: outcome({ total: 99, imported: 99 }) });

    expect(first.firstFinalize).toBe(true);
    expect(second.firstFinalize).toBe(false);
    // The replay reports what was stored, and never rewrites it.
    expect(second.counters.total).toBe(1);
    expect(second.finishedAt).toBe(first.finishedAt);
  });

  it("counts nothing from another household's session with the same recipes", async () => {
    const sessionId = await openSession();
    track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items: [importItem({ clientId: "a", record: draft(`Scoped ${RUN}`) })] }));

    const other = await imp.runOpenImportSession(db!, PUB_DID, OTHER_HH, { importer: "paprika" });
    const result = await imp.runFinalizeImportSession(db!, PUB_DID, OTHER_HH, { sessionId: other.sessionId, outcome: outcome() });
    expect(result.counters).toMatchObject({ imported: 0, linked: 0 });
  });
});

describeDb("session lifecycle (§5.3, §13)", () => {
  it("opens in parsing and moves through reviewing → committing → complete", async () => {
    const session = await imp.runOpenImportSession(db!, DID, HH, { importer: "paprika", fileName: "My Recipes.paprikarecipes", totalCount: 3 });
    expect(session).toMatchObject({ importer: "paprika", status: "parsing", fileName: "My Recipes.paprikarecipes", totalCount: 3, finishedAt: null });

    const status = async () => (await db!.selectFrom("recipe_import_session").select("status").where("id", "=", session.sessionId).executeTakeFirstOrThrow()).status;

    await imp.runProbeImportDuplicates(db!, DID, HH, { sessionId: session.sessionId, items: [probeItem({ clientId: "a" })] });
    expect(await status()).toBe("reviewing");

    track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId: session.sessionId, items: [importItem({ clientId: "a", record: draft(`Lifecycle ${RUN}`) })] }));
    expect(await status()).toBe("committing");

    await imp.runFinalizeImportSession(db!, DID, HH, { sessionId: session.sessionId, outcome: outcome({ total: 1, imported: 1 }) });
    expect(await status()).toBe("complete");

    // A late chunk cannot reopen a finished session.
    await imp.runCommitImportChunk(db!, DID, HH, { sessionId: session.sessionId, items: [] });
    expect(await status()).toBe("complete");
  });

  it("fails a session terminally and stays failed", async () => {
    const sessionId = await openSession();
    await imp.runFailImportSession(db!, DID, HH, { sessionId, stage: "parse", message: "unreadable archive" });
    const row = await db!.selectFrom("recipe_import_session").select(["status", "finished_at"]).where("id", "=", sessionId).executeTakeFirstOrThrow();
    expect(row.status).toBe("failed");
    expect(row.finished_at).not.toBeNull();

    await imp.runProbeImportDuplicates(db!, DID, HH, { sessionId, items: [] });
    const after = await db!.selectFrom("recipe_import_session").select("status").where("id", "=", sessionId).executeTakeFirstOrThrow();
    expect(after.status).toBe("failed");
  });
});
