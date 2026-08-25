import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "#/db/types";
import type { ImportEvent } from "#/lib/recipe-import/machine";
import { ulid } from "./household/ids";
import type { CommitItem, CommitItemResult, FinalizeOutcome, ProbeItem } from "./recipe-import";

/**
 * §13's two events, captured. PostHog is a no-op outside production, so without
 * this the "exactly one event per session" claim is unfalsifiable — and it is
 * the claim that broke: finalize and fail guarded on different terminal sets, so
 * one session could emit both.
 */
const captured = vi.hoisted(() => [] as Array<{ event: string; sessionId: unknown; properties: Record<string, unknown> }>);
vi.mock("#/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#/lib/posthog-server")>();
  return {
    ...actual,
    captureServerEvent: (_did: string, event: string, properties: Record<string, unknown> = {}) => {
      captured.push({ event, sessionId: properties.session_id, properties });
      return Promise.resolve();
    },
  };
});

/**
 * §9/D3 regression pin: `enqueueEnrich` may only ever fire once the recipe it
 * names has actually committed. Faking BullMQ out (real-queue behavior is
 * `enrichment-queue.test.ts`'s job) rather than skipping this — the point is
 * to see WHEN the call happens relative to the commit, not what it does.
 *
 * `dbRef` is filled in once `connectOrSkip()` resolves, below; the mock
 * factory's body only runs when something dynamically imports
 * `./enrichment-queue`, which is always well after that point. Each call reads
 * `recipeId` back through `dbRef.current` — a query issued on the pooled `db`
 * these tests already share, so it runs on whatever connection the pool hands
 * it NEXT, never the one a still-open transaction is holding. That is exactly
 * what makes it a real check: under READ COMMITTED, an insert an open
 * transaction has not committed yet is invisible on any other connection, so
 * a call fired from *inside* `persistRecipeDraft`'s (or `commitImport`'s) own
 * transaction — the bug this pins against — finds no row and gets recorded in
 * `uncommittedEnqueues`. A call fired after the commit always finds one.
 */
const dbRef = vi.hoisted(() => ({ current: null as Kysely<DB> | null }));
const uncommittedEnqueues = vi.hoisted(() => [] as string[]);
vi.mock("./enrichment-queue", () => ({
  enqueueEnrich: async (recipeId: string) => {
    const database = dbRef.current;
    if (!database) return;
    const row = await database.selectFrom("recipe").select("id").where("id", "=", recipeId).executeTakeFirst();
    if (!row) uncommittedEnqueues.push(recipeId);
  },
}));

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
dbRef.current = db;

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
  captured.length = 0;
  uncommittedEnqueues.length = 0;

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

const linkItem = (over: Partial<Extract<CommitItem, { action: "link" }>> & { clientId: string }): CommitItem => ({
  action: "link",
  entryName: `${over.clientId}.html`,
  existingRecipeId: PUBLIC,
  notes: null,
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
function track<T extends readonly CommitItemResult[]>(results: T): T {
  for (const r of results) if (r.status === "imported") created.push(r.recipeId);
  return results;
}

/**
 * What a client that observed exactly these responses would report at finalize.
 *
 * The point of counting the RESPONSES rather than hand-writing the numbers: in
 * the replay scenario the first response never arrived, so the client's totals
 * are whatever the retry said. Hand-fed first-attempt numbers make a replay test
 * pass no matter what the server does with the retry (§7.7, §16.13).
 */
function tally(results: readonly CommitItemResult[], over: Partial<FinalizeOutcome> = {}): FinalizeOutcome {
  const out = outcome({ total: results.length, ...over });
  for (const r of results) {
    if (r.status === "imported") out.imported += 1;
    else if (r.status === "linked") out.linked += 1;
    else if (r.status === "failed") out.failed += 1;
    else if (r.reason === "duplicate") out.skippedDuplicate += 1;
    else out.skippedUser += 1;
  }
  return out;
}

/** How many recipes carry this exact name — the "did it import twice?" question. */
async function recipesNamed(name: string): Promise<number> {
  const row = await db!
    .selectFrom("recipe")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("name", "=", name)
    .executeTakeFirstOrThrow();
  return row.n;
}

/** §13 events for one session, in order. */
function eventsFor(sessionId: string): string[] {
  return captured.filter((c) => c.sessionId === sessionId).map((c) => c.event);
}

/** The properties of the one §13 completion event this session emitted. */
function completionEvent(sessionId: string): Record<string, unknown> {
  const event = captured.find((c) => c.sessionId === sessionId && c.event === "recipe_import_completed");
  if (!event) throw new Error(`no recipe_import_completed for ${sessionId}`);
  return event.properties;
}

/**
 * The done screen's five tiles, computed by the client's own `finalizeOutcome`
 * over the results the server actually returned (§10.2, D24).
 *
 * The state is assembled through the real reducer rather than hand-built: the
 * defect this pins is precisely that the screen and the session row disagreed
 * about what a skip was, and a test that re-implements the screen's arithmetic
 * cannot see that. Only `clientId` and `entryName` matter to the numbers, so the
 * candidates are stubs; the verdicts are all `new` because every item here has a
 * server result and `finalizeOutcome`'s fallback (an abandoned commit) is a unit
 * test's business.
 */
async function doneScreen(items: readonly CommitItem[], results: readonly CommitItemResult[], parseFailures: readonly { clientId: string; entryName: string }[] = []) {
  const machine = await import("#/lib/recipe-import/machine");
  const parsed = items.map((item) => ({
    candidate: {
      kind: "candidate" as const,
      clientId: item.clientId,
      entryName: item.entryName,
      recipe: { name: `Entry ${item.clientId}`, ingredients: [], instructions: [] },
      sourceUrl: null,
      sourceText: null,
      notes: null,
      tags: [],
      imageUrl: null,
      localImagePath: null,
      meta: {},
    },
    sourceUrlKey: null,
    contentFp: `sha256:${item.clientId}`,
  }));

  const events: ImportEvent[] = [
    { type: "drop_accepted", fileName: "My Recipes" },
    { type: "session_opened", sessionId: "s" },
    {
      type: "parse_complete",
      result: { items: parsed, failures: parseFailures.map((f) => ({ kind: "failure" as const, clientId: f.clientId, entryName: f.entryName, message: "couldn't be read" })) },
    },
    { type: "probe_complete", verdicts: items.map((item) => ({ clientId: item.clientId, verdict: "new" as const })) },
    { type: "commit_start" },
    { type: "chunk_complete", results: [...results] },
    { type: "finalized" },
  ];

  const outcome = machine.finalizeOutcome(events.reduce(machine.reduce, machine.initialState("paprika")));
  return {
    outcome,
    /** The five tiles, in the order `ImportDoneScreen` renders them. */
    tiles: {
      imported: outcome.imported,
      linked: outcome.linked,
      alreadyYours: outcome.skippedDuplicate,
      youSkipped: outcome.skippedUser,
      didntMakeIt: outcome.failed + outcome.parseFailures,
    },
  };
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
  it("rejects every reserved key, per item, without failing the chunk", async () => {
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

  /**
   * The same four checks down the `link` arm. `validateItemMeta` is called
   * before the action branch today, so these pass for free — which is exactly
   * why they are needed: with only `import` cases, moving that call INTO the
   * import branch (and leaving `link` able to overwrite `session_id` or
   * `client_id` on a public record's sidecar) keeps the suite green.
   */
  it("rejects every reserved key on a link item too, without failing the chunk", async () => {
    const sessionId = await openSession();
    const results = await imp.runCommitImportChunk(db!, DID, HH, {
      sessionId,
      items: [...imp.RESERVED_META_KEYS.map((key) => linkItem({ clientId: `link-reserved-${key}`, meta: { [key]: "mine" } })), linkItem({ clientId: "link-clean" })],
    });

    for (const key of imp.RESERVED_META_KEYS) {
      const failed = results.find((r) => r.clientId === `link-reserved-${key}`)!;
      expect(failed.status).toBe("failed");
      expect(failed).toHaveProperty("message", expect.stringContaining(key));
    }
    expect(results.find((r) => r.clientId === "link-clean")!).toMatchObject({ status: "linked", recipeId: PUBLIC });

    // …and none of the rejected items touched the record's sidecar.
    const meta = await import("./recipe-meta");
    expect(await meta.getHouseholdRecipeMeta(db!, HH, PUBLIC, "import")).toMatchObject({ client_id: "link-clean", session_id: sessionId });
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

  it("rejects metadata over 8 kB on a link item too", async () => {
    const sessionId = await openSession();
    const results = await imp.runCommitImportChunk(db!, DID, HH, {
      sessionId,
      items: [linkItem({ clientId: "fatlink", meta: { blob: "x".repeat(9 * 1024) } })],
    });
    expect(results[0]).toMatchObject({ status: "failed" });
    expect(results[0]).toHaveProperty("message", expect.stringContaining("8192"));
    // The link never happened: nothing was added to the box.
    const boxed = await db!.selectFrom("household_recipe").select("recipe_id").where("household_id", "=", HH).execute();
    expect(boxed.map((b) => b.recipe_id)).not.toContain(PUBLIC);
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

    // §12.5's four pipeline-owned rows, the `client_id` idempotency ledger, and
    // the importer's opaque bag.
    const meta = await import("./recipe-meta");
    expect(await meta.getHouseholdRecipeMeta(db!, HH, recipeId, "import")).toEqual({
      importer: "paprika",
      session_id: sessionId,
      entry_name: "i.html",
      client_id: "i",
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
    const failure = results[0] as Extract<CommitItemResult, { status: "failed" }>;
    expect(failure.status).toBe("failed");
    expect(failure.message).toContain("already in your box");
  });

  it("is idempotent on replay: the same chunk twice leaves one of everything (§7.5)", async () => {
    const sessionId = await openSession();
    const items: CommitItem[] = [
      importItem({ clientId: "i", record: draft(`Replayed ${RUN}`), notes: "keep me" }),
      linkItem({ clientId: "l" }),
      { action: "skip", clientId: "s", entryName: "s.html" },
    ];

    const first = track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items }));
    const second = track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items }));

    expect(first.map((r) => r.status)).toEqual(["imported", "linked", "skipped"]);
    // Every item reports what it produced the first time — the same recipe ids,
    // the same statuses. NOT "skipped: duplicate": a replay is not a duplicate,
    // and reporting it as one is what let the client's counters double-count the
    // same 25 recipes as both imported and skipped (§7.7).
    expect(second).toEqual(first);

    expect(await recipesNamed(`Replayed ${RUN}`)).toBe(1);
  });

  it("replays an OVERRIDDEN duplicate to the same recipe instead of importing a second copy (§16.13)", async () => {
    const sessionId = await openSession();
    // The dedupe re-check does not fire for this item by design (the user asked
    // for a second copy), so the ledger is the only thing standing between a
    // lost response and a third copy.
    const items: CommitItem[] = [importItem({ clientId: "over", record: draft(`Overridden ${RUN}`), sourceUrl: SRC_BOX, override: "duplicate" })];

    const first = track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items }));
    const second = track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items }));

    expect(first[0].status).toBe("imported");
    expect(second[0]).toEqual(first[0]);
    expect(await recipesNamed(`Overridden ${RUN}`)).toBe(1);
  });

  it("replays to the same recipe even after the user edited it away from its dedupe keys", async () => {
    const sessionId = await openSession();
    const items: CommitItem[] = [importItem({ clientId: "e", record: draft(`Edited ${RUN}`) })];
    const first = track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items }));
    const recipeId = (first[0] as { recipeId: string }).recipeId;

    // The user renamed it and changed an ingredient, so the row's dedupe keys no
    // longer match the chunk's. Content identity cannot answer "did I already
    // commit this item?"; `(session_id, client_id)` can.
    const meta = await import("./recipe-meta");
    await db!
      .updateTable("recipe")
      .set({ name: `Edited ${RUN} (mine)` })
      .where("id", "=", recipeId)
      .execute();
    await meta.setManyRecipeMeta(db!, [{ recipeId, ns: "dedupe", entries: { source_url_key: `edited.example/${RUN}`, content_fp: `sha256:edited-${RUN}` } }]);

    const second = track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items }));
    expect(second[0]).toEqual({ clientId: "e", status: "imported", recipeId });
    expect(await recipesNamed(`Edited ${RUN}`)).toBe(0); // the edit stands
    expect(await recipesNamed(`Edited ${RUN} (mine)`)).toBe(1);
  });

  it("serializes two concurrent replays of the same item into one recipe", async () => {
    const sessionId = await openSession();
    const items: CommitItem[] = [importItem({ clientId: "race", record: draft(`Raced ${RUN}`) })];

    // Both requests in flight at once — the shape a retry actually takes when
    // the first response is merely slow rather than lost.
    const [a, b] = await Promise.all([imp.runCommitImportChunk(db!, DID, HH, { sessionId, items }), imp.runCommitImportChunk(db!, DID, HH, { sessionId, items })]);
    track(a);
    track(b);

    expect(a[0].status).toBe("imported");
    expect(b[0]).toEqual(a[0]);
    expect(await recipesNamed(`Raced ${RUN}`)).toBe(1);
  });

  it("refuses a chunk that arrives after the session finished (§5.3)", async () => {
    const sessionId = await openSession();
    await imp.runFinalizeImportSession(db!, DID, HH, { sessionId, outcome: outcome() });

    await expect(imp.runCommitImportChunk(db!, DID, HH, { sessionId, items: [importItem({ clientId: "late", record: draft(`Late ${RUN}`) })] })).rejects.toThrow(
      /already finished/i,
    );
    // …and it did not half-commit on the way to refusing.
    expect(await recipesNamed(`Late ${RUN}`)).toBe(0);
  });

  it("refuses a chunk into a failed session", async () => {
    const sessionId = await openSession();
    await imp.runFailImportSession(db!, DID, HH, { sessionId, stage: "commit", message: "died" });

    await expect(imp.runCommitImportChunk(db!, DID, HH, { sessionId, items: [importItem({ clientId: "zombie", record: draft(`Zombie ${RUN}`) })] })).rejects.toThrow(
      /already finished/i,
    );
    expect(await recipesNamed(`Zombie ${RUN}`)).toBe(0);
  });

  it("refuses a session belonging to another household (§16.17)", async () => {
    const mine = await openSession();
    await expect(imp.runCommitImportChunk(db!, PUB_DID, OTHER_HH, { sessionId: mine, items: [] })).rejects.toThrow(/not found/i);
  });
});

// --- §7.5 the wire boundary ----------------------------------------------

describeDb("the commit wire schema is loose enough to fail ONE item (§7.5, §16.11)", () => {
  /**
   * A schema-level `.min(1)` on `existingRecipeId` throws inside the validator,
   * which runs before the per-item try/catch — so one malformed item 400s all
   * 25 and the user loses a chunk to a single bad row. The client can emit
   * `existingRecipeId: ""` today; the server must not depend on it not doing so.
   */
  it("accepts a link item with an empty existingRecipeId rather than rejecting the chunk", () => {
    const parsed = imp.parseCommitChunk({
      sessionId: `s-${RUN}`,
      items: [
        { action: "link", clientId: "bad", entryName: "b.html", existingRecipeId: "", notes: null, sourceText: null, meta: {} },
        {
          action: "import",
          clientId: "good",
          entryName: "g.html",
          record: draft("Fine"),
          sourceUrl: null,
          attribution: null,
          imageSourceUrl: null,
          notes: null,
          tags: [],
          sourceText: null,
          meta: {},
        },
      ],
    });
    expect(parsed.items).toHaveLength(2);
  });

  it("accepts a skip whose reason it does not recognise, and reads it as `user`", () => {
    // A re-import is 14 chunks of almost nothing but skips; an unknown reason
    // 400ing all 25 would lose the whole session to one stale client.
    const parsed = imp.parseCommitChunk({
      sessionId: `s-${RUN}`,
      items: [
        { action: "skip", clientId: "weird", entryName: "w.html", reason: "vibes" },
        { action: "skip", clientId: "old", entryName: "o.html" },
        { action: "skip", clientId: "dupe", entryName: "d.html", reason: "duplicate" },
      ],
    });
    expect(parsed.items).toHaveLength(3);
  });

  it("turns that item into one failed result while the rest of the chunk commits", async () => {
    const sessionId = await openSession();
    const results = track(
      await imp.runCommitImportChunk(db!, DID, HH, {
        sessionId,
        items: [linkItem({ clientId: "empty", existingRecipeId: "" }), importItem({ clientId: "ok", record: draft(`Survivor ${RUN}`) }), linkItem({ clientId: "l" })],
      }),
    );

    const by = Object.fromEntries(results.map((r) => [r.clientId, r]));
    expect(by.empty).toMatchObject({ status: "failed" });
    expect(by.ok.status).toBe("imported");
    expect(by.l).toMatchObject({ status: "linked", recipeId: PUBLIC });
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
  /**
   * The replay test that means something: the client reports what it OBSERVED,
   * and in the lost-response case the only response it observed is the retry's.
   * Feeding finalize the first attempt's numbers by hand asserts nothing about
   * what the retry did.
   */
  it("derives the counters from rows, and a replayed chunk does not inflate them (§16.13)", async () => {
    const sessionId = await openSession();
    const items: CommitItem[] = [
      importItem({ clientId: "a", record: draft(`Counted A ${RUN}`) }),
      importItem({ clientId: "b", record: draft(`Counted B ${RUN}`) }),
      linkItem({ clientId: "l" }),
      // Genuinely a duplicate of something already in the box: the one skip the
      // server can derive.
      importItem({ clientId: "d", record: draft(`Counted D ${RUN}`), sourceUrl: SRC_BOX }),
      { action: "skip", clientId: "s", entryName: "s.html" },
    ];
    const first = track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items }));
    const second = track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items })); // lost response, retried
    expect(second).toEqual(first);

    const result = await imp.runFinalizeImportSession(db!, DID, HH, { sessionId, outcome: tally(second) });

    expect(result.firstFinalize).toBe(true);
    expect(result.status).toBe("complete");
    // Derived, not accumulated: two chunks, still two imports, one link, one
    // duplicate skip.
    expect(result.counters).toEqual({ total: 5, imported: 2, linked: 1, skippedDuplicate: 1, skippedUser: 1, failed: 0 });

    const row = await db!.selectFrom("recipe_import_session").selectAll().where("id", "=", sessionId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: "complete", total_count: 5, imported_count: 2, skipped_count: 2, failed_count: 0 });
    expect(row.finished_at).not.toBeNull();
  });

  it("derives BOTH skip counters from rows rather than believing the client", async () => {
    const sessionId = await openSession();
    track(
      await imp.runCommitImportChunk(db!, DID, HH, {
        sessionId,
        items: [importItem({ clientId: "d", record: draft(`Only Dupe ${RUN}`), sourceUrl: SRC_BOX }), { action: "skip", clientId: "u", entryName: "u.html", reason: "user" }],
      }),
    );

    // The client is shouting nonsense in every field finalize could have taken
    // at face value. Not one of them survives: `skipped_count` is 1 + 1.
    const result = await imp.runFinalizeImportSession(db!, DID, HH, { sessionId, outcome: outcome({ total: 2, skippedDuplicate: 99, skippedUser: 77, imported: 55, linked: 33 }) });
    expect(result.counters).toMatchObject({ skippedDuplicate: 1, skippedUser: 1, imported: 0, linked: 0 });

    const row = await db!.selectFrom("recipe_import_session").selectAll().where("id", "=", sessionId).executeTakeFirstOrThrow();
    expect(row.skipped_count).toBe(2);
  });

  it("records a skip item as a row so a user skip is a fact and not a number (§7.2)", async () => {
    const sessionId = await openSession();
    const items: CommitItem[] = [
      { action: "skip", clientId: "u1", entryName: "u1.html", reason: "user" },
      { action: "skip", clientId: "d1", entryName: "d1.html", reason: "duplicate" },
      // No reason at all: the conservative half, never the stronger claim.
      { action: "skip", clientId: "q", entryName: "q.html" },
      // A reason the server has never heard of must not 400 the chunk.
      { action: "skip", clientId: "x", entryName: "x.html", reason: "vibes" } as unknown as CommitItem,
    ];
    const results = await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items });
    expect(results.map((r) => (r.status === "skipped" ? r.reason : r.status))).toEqual(["user", "duplicate", "user", "user"]);

    const rows = await db!.selectFrom("recipe_import_skip").select(["client_id", "reason"]).where("session_id", "=", sessionId).orderBy("client_id").execute();
    expect(rows).toEqual([
      { client_id: "d1", reason: "duplicate" },
      { client_id: "q", reason: "user" },
      { client_id: "u1", reason: "user" },
      { client_id: "x", reason: "user" },
    ]);

    // Replayed: upserted by `(session_id, client_id)`, so four rows stay four rows.
    await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items });
    const after = await db!
      .selectFrom("recipe_import_skip")
      .select(sql<number>`count(*)::int`.as("n"))
      .where("session_id", "=", sessionId)
      .executeTakeFirstOrThrow();
    expect(after.n).toBe(4);
  });

  /**
   * The defect this whole seam exists to close (§7.7, §10.2 D24).
   *
   * A verified run reported `0 imported / 0 linked / 54 already yours / 287 you
   * skipped` on the done screen while `recipe_import_session` stored
   * `imported 0, skipped 341` with the split collapsed — because the client
   * dropped its skips from the chunk and then had to fold them all into the one
   * counter the server would believe. Nothing is believed now: the screen counts
   * the results the server returned, the row counts the rows the server wrote,
   * and this asserts they are the same story about the same recipes.
   */
  it("the done screen's tiles and the session row agree for a mixed session", async () => {
    const sessionId = await openSession();
    const items: CommitItem[] = [
      importItem({ clientId: "i1", record: draft(`Mixed A ${RUN}`) }),
      importItem({ clientId: "i2", record: draft(`Mixed B ${RUN}`) }),
      linkItem({ clientId: "l1" }),
      // Already in the box: the server declines it and records the skip itself.
      importItem({ clientId: "d1", record: draft(`Mixed D ${RUN}`), sourceUrl: SRC_BOX }),
      // Skipped by the client, both reasons.
      { action: "skip", clientId: "d2", entryName: "d2.html", reason: "duplicate" },
      { action: "skip", clientId: "u1", entryName: "u1.html", reason: "user" },
      { action: "skip", clientId: "u2", entryName: "u2.html", reason: "user" },
      // One item that cannot be written at all: the lexicon caps `name` at 255.
      importItem({ clientId: "f1", record: draft("N".repeat(300)) }),
    ];
    // And one entry that never became an item, so the server never hears of it.
    const parseFailures = [{ clientId: "p1", entryName: "Broken.html" }];

    const results = track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items }));
    const screen = await doneScreen(items, results, parseFailures);

    expect(screen.tiles).toEqual({ imported: 2, linked: 1, alreadyYours: 2, youSkipped: 2, didntMakeIt: 2 });

    const result = await imp.runFinalizeImportSession(db!, DID, HH, { sessionId, outcome: screen.outcome });
    const row = await db!.selectFrom("recipe_import_session").selectAll().where("id", "=", sessionId).executeTakeFirstOrThrow();

    // Tile by tile. `imported`, `linked` and both skip halves are derived from
    // rows and must equal what the screen shows; the fifth tile is the sum of
    // the commit failures the row stores and the parse failures it cannot (they
    // never reached the server, and go to the §13 event instead).
    expect(result.counters).toEqual({ total: 9, imported: 2, linked: 1, skippedDuplicate: 2, skippedUser: 2, failed: 1 });
    expect(row).toMatchObject({ status: "complete", total_count: 9, imported_count: 2, skipped_count: 4, failed_count: 1 });
    expect(screen.tiles.imported).toBe(result.counters.imported);
    expect(screen.tiles.linked).toBe(result.counters.linked);
    expect(screen.tiles.alreadyYours).toBe(result.counters.skippedDuplicate);
    expect(screen.tiles.youSkipped).toBe(result.counters.skippedUser);
    expect(screen.tiles.didntMakeIt).toBe(row.failed_count + Number(completionEvent(sessionId).parse_failures));

    // And the whole export is accounted for: nothing falls between the two.
    expect(row.imported_count + result.counters.linked + row.skipped_count + row.failed_count + Number(completionEvent(sessionId).parse_failures)).toBe(row.total_count);
    expect(screen.outcome.total).toBe(row.total_count);
  });

  it("…and still agrees after a replayed chunk", async () => {
    const sessionId = await openSession();
    const items: CommitItem[] = [
      importItem({ clientId: "i1", record: draft(`Replay Mixed A ${RUN}`) }),
      linkItem({ clientId: "l1" }),
      importItem({ clientId: "d1", record: draft(`Replay Mixed D ${RUN}`), sourceUrl: SRC_BOX }),
      { action: "skip", clientId: "d2", entryName: "d2.html", reason: "duplicate" },
      { action: "skip", clientId: "u1", entryName: "u1.html", reason: "user" },
    ];

    const first = track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items }));
    // The response was lost; the client re-sends the identical chunk. What it
    // OBSERVES is the retry's answer, so that is what the screen shows — a
    // re-sent import comes back `imported` with the same recipe id, not a
    // phantom duplicate.
    const second = track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items }));
    expect(second).toEqual(first);

    const screen = await doneScreen(items, second);
    expect(screen.tiles).toEqual({ imported: 1, linked: 1, alreadyYours: 2, youSkipped: 1, didntMakeIt: 0 });

    const result = await imp.runFinalizeImportSession(db!, DID, HH, { sessionId, outcome: screen.outcome });
    const row = await db!.selectFrom("recipe_import_session").selectAll().where("id", "=", sessionId).executeTakeFirstOrThrow();

    expect(result.counters).toEqual({ total: 5, imported: 1, linked: 1, skippedDuplicate: 2, skippedUser: 1, failed: 0 });
    expect(row).toMatchObject({ total_count: 5, imported_count: 1, skipped_count: 3, failed_count: 0 });
    expect(screen.tiles.alreadyYours + screen.tiles.youSkipped).toBe(row.skipped_count);
    // Two chunks, five recipes — not ten, and not five plus five phantom skips.
    expect(await recipesNamed(`Replay Mixed A ${RUN}`)).toBe(1);
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
    // §13, §16.20: one completion event however many times the client calls.
    expect(eventsFor(sessionId)).toEqual(["recipe_import_completed"]);
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

    // A late chunk cannot reopen a finished session — and is refused outright
    // rather than committing into it.
    await expect(imp.runCommitImportChunk(db!, DID, HH, { sessionId: session.sessionId, items: [] })).rejects.toThrow(/already finished/i);
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

  /**
   * The two terminal calls race in the real client: `failImportSession` on the
   * error path, `finalizeImportSession` on the retry that succeeded a moment
   * later (or vice versa). Whichever lands first owns the session, and §13 gets
   * exactly one event either way — never a `recipe_import_completed` for a
   * session that already reported `recipe_import_failed`.
   */
  it("does not let a late finalize resurrect a failed session", async () => {
    const sessionId = await openSession();
    track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items: [importItem({ clientId: "a", record: draft(`Doomed ${RUN}`) })] }));
    await imp.runFailImportSession(db!, DID, HH, { sessionId, stage: "commit", message: "connection lost" });

    const result = await imp.runFinalizeImportSession(db!, DID, HH, { sessionId, outcome: outcome({ total: 9, imported: 9 }) });

    expect(result.firstFinalize).toBe(false);
    expect(result.status).toBe("failed");
    const row = await db!.selectFrom("recipe_import_session").selectAll().where("id", "=", sessionId).executeTakeFirstOrThrow();
    // Still failed, and the failed session's stored numbers were not rewritten.
    expect(row).toMatchObject({ status: "failed", total_count: 3, imported_count: 0 });
    expect(eventsFor(sessionId)).toEqual(["recipe_import_failed"]);
  });

  it("does not let a late failure overwrite a completed session", async () => {
    const sessionId = await openSession();
    track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items: [importItem({ clientId: "a", record: draft(`Done ${RUN}`) })] }));
    await imp.runFinalizeImportSession(db!, DID, HH, { sessionId, outcome: outcome({ total: 1, imported: 1 }) });

    await imp.runFailImportSession(db!, DID, HH, { sessionId, stage: "commit", message: "too late" });

    const row = await db!.selectFrom("recipe_import_session").select("status").where("id", "=", sessionId).executeTakeFirstOrThrow();
    expect(row.status).toBe("complete");
    expect(eventsFor(sessionId)).toEqual(["recipe_import_completed"]);
  });
});

// --- §9/D3: recipe-enrichment enqueue ordering ----------------------------

describeDb("recipe-enrichment enqueue ordering (§9/D3)", () => {
  /**
   * Pins the bug the coordinator caught: `persistRecipeDraft` is handed the
   * chunk's own open transaction here (`commitImport`'s `trx`), so it must NOT
   * enqueue itself — only `runCommitImportChunk`'s post-commit pass may, once
   * every item's transaction has actually committed. See the `dbRef`/
   * `uncommittedEnqueues` mock at the top of this file for how "actually
   * committed" is verified.
   */
  it("never enqueues a recipe before its own transaction has committed", async () => {
    const sessionId = await openSession();
    const items = [importItem({ clientId: "pin-a" }), importItem({ clientId: "pin-b" }), importItem({ clientId: "pin-c" })];

    const results = track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items }));

    expect(results.filter((r) => r.status === "imported")).toHaveLength(3);
    expect(uncommittedEnqueues).toEqual([]);
  });

  /**
   * The replay leg of the same guarantee: a `prior` outcome (an item this
   * session already committed on an earlier chunk attempt) still reports
   * `imported` and is still fair game for `enqueueChunkEnrichment` — and by the
   * time the second chunk call returns, that recipe's row has been committed
   * (and visible to other connections) since the FIRST attempt, so this must
   * never land in `uncommittedEnqueues` either.
   */
  it("replaying an already-committed item still enqueues against a visible row", async () => {
    const sessionId = await openSession();
    const items = [importItem({ clientId: "pin-replay" })];

    const first = track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items }));
    uncommittedEnqueues.length = 0; // only the replay's own call matters here
    const replayed = track(await imp.runCommitImportChunk(db!, DID, HH, { sessionId, items }));

    expect(replayed).toEqual(first); // same recipe id both times (§7.5 ledger)
    expect(replayed[0]?.status).toBe("imported");
    expect(uncommittedEnqueues).toEqual([]);
  });
});
