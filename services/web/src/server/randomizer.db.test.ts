import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulid } from "./household/ids";

/**
 * DB-backed integration tests for `getRandomizerPool` (plan
 * `2026-08-03-meal-randomizer.md` §9).
 *
 * These require a reachable Postgres with the recipe + household tables
 * migrated. The whole suite SKIPS unless `DATABASE_URL` is set. Run it
 * against the local dev DB with:
 *
 *   railway run --service buttery -- ./node_modules/.bin/vitest run randomizer.db
 *
 * (from `services/web/`; mirrors `household/households.db.test.ts`'s
 * convention).
 *
 * `getRandomizerPool` itself is a `createServerFn` handler; calling it
 * directly outside an actual TanStack Start request throws ("No Start
 * context found in AsyncLocalStorage") because the framework's client/server
 * dispatch needs `AsyncLocalStorage` context that only exists inside a real
 * request — there is no harness for that in this repo's vitest setup, and
 * faking it means reaching into `@tanstack/start-storage-context`, a
 * transitive package not in this project's dependencies. So this suite
 * exercises `computeRandomizerPool` (the query logic, exported from
 * `randomizer.ts` specifically for this) and `validateRandomizerInput`
 * directly — the real code the handler delegates to, not a reimplementation.
 * The auth gate itself (`activeContext()`, session → did/householdId) is the
 * same helper pattern as `household-recipes.ts`'s and is not re-tested here,
 * matching how `households.db.test.ts` scopes itself to non-HTTP-session
 * logic.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("randomizer DB integration", () => {
  // Namespace this run's rows so cleanup is precise and parallel runs don't clash.
  const DID = `did:test:${ulid()}`;
  const OTHER_DID = `did:test:${ulid()}`;
  const householdId = ulid();
  const otherHouseholdId = ulid();

  // Recipe ids, namespaced per test with a shared prefix for cleanup.
  const RUN = ulid();
  const rid = (label: string) => `${RUN}-${label}`;

  const boxedIds: string[] = [];
  const corpusIds: string[] = [];

  // Loaded lazily so the module import doesn't touch `getDb()` when skipped.
  let getDb: typeof import("#/lib/db").getDb;
  let computeRandomizerPool: typeof import("./randomizer").computeRandomizerPool;
  let validateRandomizerInput: typeof import("./randomizer").validateRandomizerInput;
  let db: ReturnType<typeof import("#/lib/db").getDb>;

  beforeAll(async () => {
    ({ getDb } = await import("#/lib/db"));
    ({ computeRandomizerPool, validateRandomizerInput } = await import("./randomizer"));
    db = getDb();

    // --- household + membership -------------------------------------
    await db.insertInto("household").values({ id: householdId, name: "Randomizer Test", created_by_did: DID }).execute();
    await db.insertInto("household_member").values({ household_id: householdId, did: DID, role: "owner", invited_by_did: null }).execute();
    // A second, unrelated household — used to prove scoping (not directly
    // asserted on below, but keeps the fixture honest about what "your box"
    // means).
    await db.insertInto("household").values({ id: otherHouseholdId, name: "Other", created_by_did: OTHER_DID }).execute();
    await db.insertInto("household_member").values({ household_id: otherHouseholdId, did: OTHER_DID, role: "owner", invited_by_did: null }).execute();

    // --- recipes -------------------------------------------------------
    // Boxed recipes (the household's shelf):
    //  - italian-soup: cuisine=italian, category=soup, 20min, has "garlic"
    //  - mexican-entree: cuisine=mexican, category=entree, 45min, has "cumin"
    //  - untimed: cuisine=italian, category=entree, no total_time, has "basil"
    const boxedRows: Array<{ id: string; name: string; cuisine: string | null; category: string | null; totalTimeSeconds: number | null }> = [
      { id: rid("italian-soup"), name: "Italian Soup", cuisine: "italian", category: "soup", totalTimeSeconds: 20 * 60 },
      { id: rid("mexican-entree"), name: "Mexican Entree", cuisine: "mexican", category: "entree", totalTimeSeconds: 45 * 60 },
      { id: rid("untimed"), name: "Untimed Italian Entree", cuisine: "italian", category: "entree", totalTimeSeconds: null },
    ];
    for (const r of boxedRows) {
      await db
        .insertInto("recipe")
        .values({ id: r.id, origin: "local", name: r.name, visibility: "public", recipe_cuisine: r.cuisine, recipe_category: r.category, total_time_seconds: r.totalTimeSeconds })
        .execute();
      await db.insertInto("household_recipe").values({ household_id: householdId, recipe_id: r.id, added_by_did: DID }).execute();
      boxedIds.push(r.id);
    }
    await db
      .insertInto("recipe_ingredient")
      .values({ recipe_id: rid("italian-soup"), ordinal: 0, text: "2 cloves Garlic, minced" })
      .execute();
    await db
      .insertInto("recipe_ingredient")
      .values({ recipe_id: rid("mexican-entree"), ordinal: 0, text: "1 tsp Cumin" })
      .execute();
    await db
      .insertInto("recipe_ingredient")
      .values({ recipe_id: rid("untimed"), ordinal: 0, text: "Fresh basil leaves" })
      .execute();

    // Corpus-only public recipes, NOT boxed — used for source:"corpus" widening.
    //  - corpus-italian: cuisine=italian, category=entree, 10min (matches an
    //    italian/entree filter and would be excluded once boxed)
    //  - corpus-private: same shape but visibility='private' (must never surface)
    await db
      .insertInto("recipe")
      .values({
        id: rid("corpus-italian"),
        origin: "sync",
        name: "Corpus Italian",
        visibility: "public",
        recipe_cuisine: "italian",
        recipe_category: "entree",
        total_time_seconds: 10 * 60,
      })
      .execute();
    corpusIds.push(rid("corpus-italian"));
    await db
      .insertInto("recipe")
      .values({
        id: rid("corpus-private"),
        origin: "sync",
        name: "Corpus Private",
        visibility: "private",
        recipe_cuisine: "italian",
        recipe_category: "entree",
        total_time_seconds: 10 * 60,
      })
      .execute();
    corpusIds.push(rid("corpus-private"));
  });

  afterAll(async () => {
    if (!db) return;
    const allIds = [...boxedIds, ...corpusIds];
    await db.deleteFrom("recipe_ingredient").where("recipe_id", "in", allIds).execute();
    await db.deleteFrom("household_recipe").where("household_id", "=", householdId).execute();
    await db.deleteFrom("recipe").where("id", "in", allIds).execute();
    await db.deleteFrom("household_member").where("household_id", "in", [householdId, otherHouseholdId]).execute();
    await db.deleteFrom("household").where("id", "in", [householdId, otherHouseholdId]).execute();
  });

  const box = (overrides: Partial<Parameters<typeof validateRandomizerInput>[0]> = {}) => validateRandomizerInput({ source: "box", ...overrides });

  it("no filters returns the whole box, excluding untimed by default only when maxCookMinutes is set", async () => {
    const result = await computeRandomizerPool(db, DID, householdId, box());
    const ids = result.pool.map((c) => c.recipeId).sort();
    expect(ids).toEqual([rid("italian-soup"), rid("mexican-entree"), rid("untimed")].sort());
  });

  it("filters by cuisine in isolation", async () => {
    const result = await computeRandomizerPool(db, DID, householdId, box({ cuisine: "italian" }));
    const ids = result.pool.map((c) => c.recipeId).sort();
    expect(ids).toEqual([rid("italian-soup"), rid("untimed")].sort());
  });

  it("filters by category in isolation", async () => {
    const result = await computeRandomizerPool(db, DID, householdId, box({ category: "entree" }));
    const ids = result.pool.map((c) => c.recipeId).sort();
    expect(ids).toEqual([rid("mexican-entree"), rid("untimed")].sort());
  });

  it("maxCookMinutes excludes null-time rows by default", async () => {
    const result = await computeRandomizerPool(db, DID, householdId, box({ maxCookMinutes: 30 }));
    const ids = result.pool.map((c) => c.recipeId);
    expect(ids).toEqual([rid("italian-soup")]);
  });

  it("maxCookMinutes + includeUntimed keeps null-time rows eligible", async () => {
    const result = await computeRandomizerPool(db, DID, householdId, box({ maxCookMinutes: 30, includeUntimed: true }));
    const ids = result.pool.map((c) => c.recipeId).sort();
    expect(ids).toEqual([rid("italian-soup"), rid("untimed")].sort());
  });

  it("ingredient substring match is case-insensitive (ILIKE)", async () => {
    const lower = await computeRandomizerPool(db, DID, householdId, box({ ingredient: "garlic" }));
    const upper = await computeRandomizerPool(db, DID, householdId, box({ ingredient: "GARLIC" }));
    const mixed = await computeRandomizerPool(db, DID, householdId, box({ ingredient: "GaRlIc" }));
    for (const result of [lower, upper, mixed]) {
      expect(result.pool.map((c) => c.recipeId)).toEqual([rid("italian-soup")]);
    }
  });

  it("ingredient substring matches mid-word, not just whole words", async () => {
    const result = await computeRandomizerPool(db, DID, householdId, box({ ingredient: "asi" })); // "basil"
    expect(result.pool.map((c) => c.recipeId)).toEqual([rid("untimed")]);
  });

  it("filters AND-combine: cuisine + category + maxCookMinutes together", async () => {
    const result = await computeRandomizerPool(db, DID, householdId, box({ cuisine: "italian", category: "soup", maxCookMinutes: 30 }));
    expect(result.pool.map((c) => c.recipeId)).toEqual([rid("italian-soup")]);
  });

  it("filters AND-combine to an empty pool when nothing matches", async () => {
    const result = await computeRandomizerPool(db, DID, householdId, box({ cuisine: "mexican", category: "soup" }));
    expect(result.pool).toEqual([]);
  });

  it("facets are always the full box's distinct cuisines/categories, regardless of active filters", async () => {
    const filtered = await computeRandomizerPool(db, DID, householdId, box({ cuisine: "italian", category: "soup" }));
    const cuisineSlugs = filtered.facets.cuisines.map((f) => f.slug).sort();
    const categorySlugs = filtered.facets.categories.map((f) => f.slug).sort();
    expect(cuisineSlugs).toEqual(["italian", "mexican"]);
    expect(categorySlugs).toEqual(["entree", "soup"]);
    // Prettified labels.
    expect(filtered.facets.cuisines.find((f) => f.slug === "italian")?.label).toBe("Italian");
  });

  it("source: box never includes cappedAtLimit and never surfaces corpus-only recipes", async () => {
    const result = await computeRandomizerPool(db, DID, householdId, box());
    expect(result.cappedAtLimit).toBe(false);
    expect(result.pool.map((c) => c.recipeId)).not.toContain(rid("corpus-italian"));
  });

  it("source: corpus surfaces matching public recipes not yet boxed, and excludes private ones", async () => {
    const result = await computeRandomizerPool(db, DID, householdId, validateRandomizerInput({ source: "corpus", cuisine: "italian", category: "entree" }));
    const ids = result.pool.map((c) => c.recipeId);
    expect(ids).toContain(rid("corpus-italian"));
    expect(ids).not.toContain(rid("corpus-private")); // visibility='private' must never surface
    expect(result.cappedAtLimit).toBe(false);
  });

  it("corpus widening excludes recipes already in the box", async () => {
    // Box "corpus-italian" temporarily, then confirm it drops out of a corpus draw.
    await db
      .insertInto("household_recipe")
      .values({ household_id: householdId, recipe_id: rid("corpus-italian"), added_by_did: DID })
      .execute();
    try {
      const result = await computeRandomizerPool(db, DID, householdId, validateRandomizerInput({ source: "corpus", cuisine: "italian", category: "entree" }));
      expect(result.pool.map((c) => c.recipeId)).not.toContain(rid("corpus-italian"));
    } finally {
      await db.deleteFrom("household_recipe").where("household_id", "=", householdId).where("recipe_id", "=", rid("corpus-italian")).execute();
    }
  });

  it("a household with no box rows draws an empty pool with empty facets (fails closed, not an error)", async () => {
    const result = await computeRandomizerPool(db, DID, otherHouseholdId, box());
    expect(result.pool).toEqual([]);
    expect(result.facets.cuisines).toEqual([]);
    expect(result.facets.categories).toEqual([]);
  });

  it("a non-member DID scoped to someone else's household draws nothing — the membership join IS the authorization gate", async () => {
    // OTHER_DID is a live member of `otherHouseholdId`, NOT of `householdId`.
    // `computeRandomizerPool` never checks membership independently — it's
    // `householdScopedQuery`'s inner join to a live `household_member` row
    // that makes this fail closed: no row exists for (OTHER_DID, householdId),
    // so the join yields nothing, not another tenant's box.
    //
    // The higher-level "non-member / no active household" gate (`activeContext()`
    // throwing `NotAMemberError` / redirecting to /login) lives in the
    // `createServerFn` handler, which requires a real HTTP session to exercise
    // (see the file header) — this test covers the DB-level authorization
    // chokepoint the handler relies on, mirroring how `households.db.test.ts`
    // covers `loadLiveMembership` rather than the session-gated handlers.
    const result = await computeRandomizerPool(db, OTHER_DID, householdId, box());
    expect(result.pool).toEqual([]);
    expect(result.facets.cuisines).toEqual([]);
    expect(result.facets.categories).toEqual([]);
  });

  describe("validateRandomizerInput", () => {
    it("defaults source to box and includeUntimed to false", () => {
      expect(validateRandomizerInput({})).toEqual({
        cuisine: undefined,
        category: undefined,
        maxCookMinutes: undefined,
        includeUntimed: false,
        ingredient: undefined,
        source: "box",
      });
    });

    it("ignores invalid maxCookMinutes rather than throwing", () => {
      expect(validateRandomizerInput({ maxCookMinutes: -5 }).maxCookMinutes).toBeUndefined();
      expect(validateRandomizerInput({ maxCookMinutes: Number.NaN }).maxCookMinutes).toBeUndefined();
      expect(validateRandomizerInput({ maxCookMinutes: 0 }).maxCookMinutes).toBeUndefined();
      expect(validateRandomizerInput({ maxCookMinutes: 30 }).maxCookMinutes).toBe(30);
    });

    it("clamps ingredient to ~200 chars", () => {
      const long = "x".repeat(500);
      expect(validateRandomizerInput({ ingredient: long }).ingredient?.length).toBe(200);
    });

    it("rejects an unknown source, falling back to box", () => {
      // biome-ignore-line: exercising an invalid runtime value on purpose
      expect(validateRandomizerInput({ source: "bogus" as "box" }).source).toBe("box");
    });
  });
});
