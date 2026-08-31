import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "#/db/types";
import { type PlanDate, shiftDays, todayIn } from "#/lib/plan/week";
import { ulid } from "./household/ids";

/**
 * DB-backed integration tests for the meal randomizer (plan §4, §10).
 *
 * These need a real Postgres with the migrations applied — the whole point is
 * the things a unit test cannot see: the `recipe_enrichment_label` verdict
 * asymmetry, the household join that IS the authorization, and real date
 * arithmetic against `meal_plan_entry.plan_date`.
 *
 * Run them against the local dev stack with:
 *
 *   bash /home/user/buttery/scripts/dev/vitest-db.sh randomizer
 *
 * With no reachable database the whole suite SKIPS with a message rather than
 * failing, so `pnpm test` stays green on a machine that has never booted the
 * stack. See `services/web/vitest.config.ts` for the project split.
 *
 * `getRandomizerPool` takes its household from the session, so these tests
 * drive the exported, session-free body `readRandomizerPool` directly and
 * assert against its return value and (where useful) the tables themselves.
 * Nothing here fakes a session.
 *
 * Every test rebuilds its own scratch fixture in `beforeEach` and the suite
 * deletes all of it in `afterAll`, so a run leaves the dev database exactly
 * as it found it and no test can depend on another.
 */

// --- reachability probe ----------------------------------------------------

let skipReason = "";

function announceSkip(reason: string): void {
  skipReason = reason;
  process.stderr.write(`\nSKIPPING randomizer DB tests — ${reason}.\nRun them against the local dev stack with \`bash scripts/dev/vitest-db.sh randomizer\`.\n\n`);
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
      sql`select 1 from recipe_enrichment_label limit 0`.execute(db),
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

// --- fixture ----------------------------------------------------------------

/** One namespace per run so a crashed run can never collide with the next. */
const RUN = ulid();

const HH_A = `hh-a-${RUN}`;
const HH_B = `hh-b-${RUN}`;
const HOUSEHOLDS = [HH_A, HH_B];

const DID_A = `did:test:a-${RUN}`;
/** Owner of HH_B, and a member of nothing else — the non-member scoping test. */
const DID_B = `did:test:b-${RUN}`;
const DIDS = [DID_A, DID_B];

// HH_A's box — one recipe per thing this suite has to exercise.
const R_IT_AUTHOR = `r-it-author-${RUN}`; // recipe_cuisine='italian' (author column), 30m
const R_IT_LABEL = `r-it-label-${RUN}`; // enrichment cuisine label 'italian' only, 42m
const R_MX = `r-mx-${RUN}`; // recipe_cuisine='mexican', 20m
const R_UNTIMED_IT = `r-untimed-it-${RUN}`; // recipe_cuisine='italian', total_time_seconds NULL
const R_SLOW = `r-slow-${RUN}`; // 120m, no cuisine
const R_VEG = `r-veg-${RUN}`; // diet vegetarian likely
const R_VEGAN_KETO = `r-vegan-keto-${RUN}`; // diet vegan + keto likely (AND test)
const R_VEGAN_EXCLUDED = `r-vegan-excluded-${RUN}`; // diet vegan EXCLUDED — the verdict the diet filter must not accept
const R_GLUTEN_DIET = `r-gluten-diet-${RUN}`; // diet gluten_free likely (facet-exclusion test)
const R_DAIRY_DIET = `r-dairy-diet-${RUN}`; // diet dairy_free likely — the OTHER half of the same facet exclusion
const R_PEANUT_CONTAINS = `r-peanut-contains-${RUN}`;
const R_MILK_MAYCONTAIN = `r-milk-maycontain-${RUN}`;
const R_PEANUT_NOTDETECTED = `r-peanut-notdetected-${RUN}`;
const R_PEANUT_UNKNOWN = `r-peanut-unknown-${RUN}`;
const R_NO_ALLERGEN_ROW = `r-no-allergen-row-${RUN}`;
const R_BREAKFAST = `r-breakfast-${RUN}`;
const R_LUNCH = `r-lunch-${RUN}`; // meal_type lunch — canonical order puts it BETWEEN breakfast and dinner, alphabetical puts it after both
const R_DINNER = `r-dinner-${RUN}`;
const R_MILD = `r-mild-${RUN}`;
const R_HOT = `r-hot-${RUN}`;
const R_PERCENT = `r-percent-${RUN}`; // ingredient text literally contains "%"
const R_UNDERSCORE = `r-underscore-${RUN}`; // ingredient text literally contains "_"
const R_MIXED_CASE = `r-mixed-case-${RUN}`; // ingredient text "Chicken Thigh"
const R_BACKSLASH = `r-backslash-${RUN}`; // ingredient text literally contains a backslash — the third character `escapeLikePattern` handles
const R_NO_ENRICHMENT = `r-no-enrichment-${RUN}`; // no recipe_enrichment row at all
const R_ENRICHMENT_ERROR = `r-enrichment-error-${RUN}`; // recipe_enrichment.status = 'error'
const R_ENRICHMENT_OK = `r-enrichment-ok-${RUN}`; // recipe_enrichment.status = 'ok', no labels
const R_FAVORITE = `r-favorite-${RUN}`;
const R_IN_COLLECTION = `r-in-collection-${RUN}`;
const R_RECENT_PLAN = `r-recent-plan-${RUN}`;
const R_OLD_PLAN = `r-old-plan-${RUN}`;
const R_SOFT_DELETED_RECENT = `r-soft-deleted-recent-${RUN}`;
const R_COMBO = `r-combo-${RUN}`; // italian + vegetarian + 17m + no allergens — the AND-combined target

const HH_A_RECIPES = [
  R_IT_AUTHOR,
  R_IT_LABEL,
  R_MX,
  R_UNTIMED_IT,
  R_SLOW,
  R_VEG,
  R_VEGAN_KETO,
  R_VEGAN_EXCLUDED,
  R_GLUTEN_DIET,
  R_DAIRY_DIET,
  R_PEANUT_CONTAINS,
  R_MILK_MAYCONTAIN,
  R_PEANUT_NOTDETECTED,
  R_PEANUT_UNKNOWN,
  R_NO_ALLERGEN_ROW,
  R_BREAKFAST,
  R_LUNCH,
  R_DINNER,
  R_MILD,
  R_HOT,
  R_PERCENT,
  R_UNDERSCORE,
  R_MIXED_CASE,
  R_BACKSLASH,
  R_NO_ENRICHMENT,
  R_ENRICHMENT_ERROR,
  R_ENRICHMENT_OK,
  R_FAVORITE,
  R_IN_COLLECTION,
  R_RECENT_PLAN,
  R_OLD_PLAN,
  R_SOFT_DELETED_RECENT,
  R_COMBO,
];

// Corpus (widen-to-public) fixture.
const R_CORPUS_PUBLIC = `r-corpus-public-${RUN}`; // public, never boxed — appears in a corpus draw
const R_CORPUS_BOXED = `r-corpus-boxed-${RUN}`; // public, but boxed by HH_A — excluded (anti-join)
const R_CORPUS_DRAFT = `r-corpus-draft-${RUN}`; // draft, never boxed — excluded (visibility)
const R_CORPUS_OTHERBOX = `r-corpus-otherbox-${RUN}`; // public, boxed by HH_B ONLY — still new to HH_A, so it must survive the anti-join
const CORPUS_RECIPES = [R_CORPUS_PUBLIC, R_CORPUS_BOXED, R_CORPUS_DRAFT, R_CORPUS_OTHERBOX];

const RECIPES = [...HH_A_RECIPES, ...CORPUS_RECIPES];

const COLLECTION_ID = `col-${RUN}`;

/**
 * 14 hours off UTC, deliberately: `readRandomizerPool`'s recency window must
 * read `todayIn(timezone)` off THIS household's stored preference, never the
 * server's own clock (§4.6). If it ever regressed to `current_date`, this
 * suite's recency dates (anchored to this zone) would land on the wrong side
 * of the boundary for a UTC-anchored implementation for large parts of the
 * day.
 */
const HH_A_ZONE = "Pacific/Kiritimati";

// Loaded lazily so a skipped run never imports the server modules at all.
type Randomizer = typeof import("./randomizer");
type Preferences = typeof import("./household/preferences");
let randomizer: Randomizer;
let prefs: Preferences;

let today: PlanDate;
let RECENT_DATE: PlanDate;
let OLD_DATE: PlanDate;

async function reset(): Promise<void> {
  if (!db) return;

  today = todayIn(HH_A_ZONE);
  RECENT_DATE = shiftDays(today, -3); // inside the default 14-day window
  OLD_DATE = shiftDays(today, -30); // outside it

  // Order matters: children before parents.
  await db.deleteFrom("meal_plan_entry").where("household_id", "in", HOUSEHOLDS).execute();
  await db.deleteFrom("recipe_collection_entry").where("household_id", "in", HOUSEHOLDS).execute();
  await db.deleteFrom("recipe_collection").where("household_id", "in", HOUSEHOLDS).execute();
  await db.deleteFrom("household_recipe").where("household_id", "in", HOUSEHOLDS).execute();
  await db.deleteFrom("recipe_enrichment_label").where("recipe_id", "in", RECIPES).execute();
  await db.deleteFrom("recipe_enrichment").where("recipe_id", "in", RECIPES).execute();
  await db.deleteFrom("recipe_ingredient").where("recipe_id", "in", RECIPES).execute();
  await db.deleteFrom("recipe").where("id", "in", RECIPES).execute();

  await db
    .insertInto("recipe")
    .values([
      { id: R_IT_AUTHOR, origin: "local", visibility: "public", name: "Author Italian", recipe_cuisine: "italian", total_time_seconds: 1800 },
      { id: R_IT_LABEL, origin: "local", visibility: "public", name: "Label Italian", total_time_seconds: 2520 },
      { id: R_MX, origin: "local", visibility: "public", name: "Author Mexican", recipe_cuisine: "mexican", total_time_seconds: 1200 },
      { id: R_UNTIMED_IT, origin: "local", visibility: "public", name: "Untimed Italian", recipe_cuisine: "italian", total_time_seconds: null },
      { id: R_SLOW, origin: "local", visibility: "public", name: "Slow Cooker", total_time_seconds: 7200 },
      { id: R_VEG, origin: "local", visibility: "public", name: "Vegetarian Bowl", total_time_seconds: 1500 },
      { id: R_VEGAN_KETO, origin: "local", visibility: "public", name: "Vegan Keto Plate", total_time_seconds: 1500 },
      { id: R_VEGAN_EXCLUDED, origin: "local", visibility: "public", name: "Definitely Not Vegan", total_time_seconds: 1500 },
      { id: R_GLUTEN_DIET, origin: "local", visibility: "public", name: "Gluten Free Diet Label", total_time_seconds: 1500 },
      { id: R_DAIRY_DIET, origin: "local", visibility: "public", name: "Dairy Free Diet Label", total_time_seconds: 1500 },
      { id: R_PEANUT_CONTAINS, origin: "local", visibility: "public", name: "Peanut Contains", total_time_seconds: 1500 },
      { id: R_MILK_MAYCONTAIN, origin: "local", visibility: "public", name: "Milk May Contain", total_time_seconds: 1500 },
      { id: R_PEANUT_NOTDETECTED, origin: "local", visibility: "public", name: "Peanut Not Detected", total_time_seconds: 1500 },
      { id: R_PEANUT_UNKNOWN, origin: "local", visibility: "public", name: "Peanut Unknown", total_time_seconds: 1500 },
      { id: R_NO_ALLERGEN_ROW, origin: "local", visibility: "public", name: "No Allergen Row", total_time_seconds: 1500 },
      { id: R_BREAKFAST, origin: "local", visibility: "public", name: "Breakfast Meal Type", total_time_seconds: 600 },
      { id: R_LUNCH, origin: "local", visibility: "public", name: "Lunch Meal Type", total_time_seconds: 900 },
      { id: R_DINNER, origin: "local", visibility: "public", name: "Dinner Meal Type", total_time_seconds: 3000 },
      { id: R_MILD, origin: "local", visibility: "public", name: "Mild Spice", total_time_seconds: 1500 },
      { id: R_HOT, origin: "local", visibility: "public", name: "Hot Spice", total_time_seconds: 1500 },
      { id: R_PERCENT, origin: "local", visibility: "public", name: "Percent Ingredient", total_time_seconds: 1500 },
      { id: R_UNDERSCORE, origin: "local", visibility: "public", name: "Underscore Ingredient", total_time_seconds: 1500 },
      { id: R_MIXED_CASE, origin: "local", visibility: "public", name: "Mixed Case Ingredient", total_time_seconds: 1500 },
      { id: R_BACKSLASH, origin: "local", visibility: "public", name: "Backslash Ingredient", total_time_seconds: 1500 },
      { id: R_NO_ENRICHMENT, origin: "local", visibility: "public", name: "No Enrichment Row", total_time_seconds: 1500 },
      { id: R_ENRICHMENT_ERROR, origin: "local", visibility: "public", name: "Enrichment Errored", total_time_seconds: 1500 },
      { id: R_ENRICHMENT_OK, origin: "local", visibility: "public", name: "Enrichment OK No Labels", total_time_seconds: 1500 },
      { id: R_FAVORITE, origin: "local", visibility: "public", name: "Favorited", total_time_seconds: 1500 },
      { id: R_IN_COLLECTION, origin: "local", visibility: "public", name: "In Collection", total_time_seconds: 1500 },
      { id: R_RECENT_PLAN, origin: "local", visibility: "public", name: "Recently Planned", total_time_seconds: 1500 },
      { id: R_OLD_PLAN, origin: "local", visibility: "public", name: "Planned Long Ago", total_time_seconds: 1500 },
      { id: R_SOFT_DELETED_RECENT, origin: "local", visibility: "public", name: "Soft Deleted Recent Plan", total_time_seconds: 1500 },
      { id: R_COMBO, origin: "local", visibility: "public", name: "Combo Target", recipe_cuisine: "italian", total_time_seconds: 1000 },
      { id: R_CORPUS_PUBLIC, origin: "local", visibility: "public", name: "Corpus Public" },
      { id: R_CORPUS_BOXED, origin: "local", visibility: "public", name: "Corpus Boxed" },
      { id: R_CORPUS_DRAFT, origin: "local", visibility: "draft", name: "Corpus Draft" },
      { id: R_CORPUS_OTHERBOX, origin: "local", visibility: "public", name: "Corpus Boxed By Someone Else" },
    ])
    .execute();

  await db
    .insertInto("household_recipe")
    .values([
      ...HH_A_RECIPES.map((recipe_id) => ({ household_id: HH_A, recipe_id, added_by_did: DID_A })),
      { household_id: HH_A, recipe_id: R_CORPUS_BOXED, added_by_did: DID_A },
      // HH_B's box, not HH_A's — the anti-join must be scoped per household.
      { household_id: HH_B, recipe_id: R_CORPUS_OTHERBOX, added_by_did: DID_B },
    ])
    .execute();

  await db.updateTable("household_recipe").set({ favorite: true }).where("household_id", "=", HH_A).where("recipe_id", "=", R_FAVORITE).execute();

  // Every HH_A recipe gets a status='ok' enrichment row EXCEPT the two whose
  // whole point is coverage (§4.3): R_NO_ENRICHMENT (no row at all) and
  // R_ENRICHMENT_ERROR (a row, but not 'ok').
  // R_CORPUS_BOXED lives in HH_A's box too (it's the corpus test's "already
  // boxed" fixture) but isn't in `HH_A_RECIPES` — it still needs a status='ok'
  // row so it doesn't silently inflate `unenrichedInScope` below.
  const okRecipeIds = [...HH_A_RECIPES.filter((id) => id !== R_NO_ENRICHMENT && id !== R_ENRICHMENT_ERROR), R_CORPUS_BOXED];
  await db
    .insertInto("recipe_enrichment")
    .values([...okRecipeIds.map((recipe_id) => ({ recipe_id, status: "ok" })), { recipe_id: R_ENRICHMENT_ERROR, status: "error" }])
    .execute();

  const label = (recipe_id: string, dimension: string, slug: string, verdict: string) => ({ recipe_id, dimension, slug, verdict, confidence: "0.9", method: "rules@1" });
  await db
    .insertInto("recipe_enrichment_label")
    .values([
      label(R_IT_LABEL, "cuisine", "italian", "likely"),
      label(R_VEG, "diet", "vegetarian", "likely"),
      label(R_VEGAN_KETO, "diet", "vegan", "likely"),
      label(R_VEGAN_KETO, "diet", "keto", "likely"),
      // `excluded` is a real diet verdict (migration 1787679680100's check
      // constraint: excluded | likely | unknown) and it means the OPPOSITE of a
      // match. §4.2 requires `verdict = 'likely'`, so this row must never
      // satisfy `diets: ["vegan"]`.
      label(R_VEGAN_EXCLUDED, "diet", "vegan", "excluded"),
      label(R_GLUTEN_DIET, "diet", "gluten_free", "likely"),
      label(R_DAIRY_DIET, "diet", "dairy_free", "likely"),
      label(R_PEANUT_CONTAINS, "allergen", "peanut", "contains"),
      label(R_MILK_MAYCONTAIN, "allergen", "milk", "may_contain"),
      label(R_PEANUT_NOTDETECTED, "allergen", "peanut", "not_detected"),
      label(R_PEANUT_UNKNOWN, "allergen", "peanut", "unknown"),
      // `soy` and `egg` appear in the box ONLY with a non-positive verdict, so
      // they must never reach the Avoid… facet — an option that can exclude
      // nothing. `peanut` cannot prove that on its own: it is present via
      // R_PEANUT_CONTAINS either way.
      label(R_PEANUT_NOTDETECTED, "allergen", "soy", "not_detected"),
      label(R_PEANUT_UNKNOWN, "allergen", "egg", "unknown"),
      label(R_BREAKFAST, "meal_type", "breakfast", "likely"),
      label(R_LUNCH, "meal_type", "lunch", "likely"),
      label(R_DINNER, "meal_type", "dinner", "likely"),
      label(R_MILD, "spice_level", "mild", "likely"),
      label(R_HOT, "spice_level", "hot", "likely"),
      label(R_COMBO, "diet", "vegetarian", "likely"),
    ])
    .execute();

  await db
    .insertInto("recipe_ingredient")
    .values([
      { recipe_id: R_PERCENT, ordinal: 0, text: "5% milk" },
      { recipe_id: R_UNDERSCORE, ordinal: 0, text: "all_purpose flour" },
      { recipe_id: R_MIXED_CASE, ordinal: 0, text: "Chicken Thigh" },
      // One real backslash, then "b sauce" — `"a\\b sauce"` in TS source.
      { recipe_id: R_BACKSLASH, ordinal: 0, text: "a\\b sauce" },
    ])
    .execute();

  await db.insertInto("recipe_collection").values({ id: COLLECTION_ID, household_id: HH_A, name: "Test Collection", position: 0, created_by_did: DID_A }).execute();
  await db
    .insertInto("recipe_collection_entry")
    .values({ collection_id: COLLECTION_ID, household_id: HH_A, recipe_id: R_IN_COLLECTION, position: 0, added_by_did: DID_A })
    .execute();

  await db
    .insertInto("meal_plan_entry")
    .values([
      { id: `${RUN}-mpe-recent`, household_id: HH_A, plan_date: RECENT_DATE, slot: "dinner", kind: "recipe", position: 0, recipe_id: R_RECENT_PLAN, created_by_did: DID_A },
      { id: `${RUN}-mpe-old`, household_id: HH_A, plan_date: OLD_DATE, slot: "dinner", kind: "recipe", position: 0, recipe_id: R_OLD_PLAN, created_by_did: DID_A },
      {
        id: `${RUN}-mpe-soft-deleted`,
        household_id: HH_A,
        plan_date: RECENT_DATE,
        slot: "lunch",
        kind: "recipe",
        position: 0,
        recipe_id: R_SOFT_DELETED_RECENT,
        created_by_did: DID_A,
        deleted_at: new Date(),
      },
    ])
    .execute();
}

// --- assertion helpers -------------------------------------------------------

function ids(pool: Array<{ recipeId: string }>): string[] {
  return pool.map((card) => card.recipeId);
}

// --- suite -------------------------------------------------------------------

describe.skipIf(!db)(db ? "randomizer DB integration (§4, §10)" : `randomizer DB integration (§4, §10) — SKIPPED: ${skipReason}`, () => {
  beforeAll(async () => {
    randomizer = await import("./randomizer");
    prefs = await import("./household/preferences");

    await db!
      .insertInto("household")
      .values([
        { id: HH_A, name: "Scratch A", created_by_did: DID_A },
        { id: HH_B, name: "Scratch B", created_by_did: DID_B },
      ])
      .execute();
    await db!
      .insertInto("household_member")
      .values([
        { household_id: HH_A, did: DID_A, role: "owner", invited_by_did: null },
        { household_id: HH_B, did: DID_B, role: "owner", invited_by_did: null },
      ])
      .execute();
    await prefs.writeHouseholdPreferences(HH_A, { weekStartDay: 1, timezone: HH_A_ZONE });
  });

  beforeEach(reset);

  afterAll(async () => {
    if (!db) return;
    await db.deleteFrom("meal_plan_entry").where("household_id", "in", HOUSEHOLDS).execute();
    await db.deleteFrom("recipe_collection_entry").where("household_id", "in", HOUSEHOLDS).execute();
    await db.deleteFrom("recipe_collection").where("household_id", "in", HOUSEHOLDS).execute();
    await db.deleteFrom("household_recipe").where("household_id", "in", HOUSEHOLDS).execute();
    await db.deleteFrom("household_preference").where("household_id", "in", HOUSEHOLDS).execute();
    await db.deleteFrom("recipe_enrichment_label").where("recipe_id", "in", RECIPES).execute();
    await db.deleteFrom("recipe_enrichment").where("recipe_id", "in", RECIPES).execute();
    await db.deleteFrom("recipe_ingredient").where("recipe_id", "in", RECIPES).execute();
    await db.deleteFrom("recipe").where("id", "in", RECIPES).execute();
    await db.deleteFrom("household_member").where("household_id", "in", HOUSEHOLDS).execute();
    await db.deleteFrom("household").where("id", "in", HOUSEHOLDS).execute();
    await db.deleteFrom("household_member").where("did", "in", DIDS).execute();
    await db.destroy();
  });

  // --- §4.3 scope + coverage aggregates -------------------------------------

  describe("scope + coverage aggregates (§4.3)", () => {
    it("totalInScope is the whole box, before any filter", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, {});
      // +1: R_CORPUS_BOXED also lives in HH_A's box (the corpus test's
      // "already boxed" fixture) but isn't tracked in `HH_A_RECIPES`.
      expect(pool.totalInScope).toBe(HH_A_RECIPES.length + 1);
    });

    it("unenrichedInScope counts rows with no recipe_enrichment row, or status <> 'ok' — regardless of any other filter", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { cuisine: "italian" });
      // Scope-wide, not filtered: still 2, even though the cuisine filter above
      // matches neither R_NO_ENRICHMENT nor R_ENRICHMENT_ERROR.
      expect(pool.unenrichedInScope).toBe(2);
    });

    it("a coverage-only recipe never appears in the pool by itself (it carries no matching label)", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { mealType: "breakfast" });
      expect(ids(pool.pool)).not.toContain(R_NO_ENRICHMENT);
      expect(ids(pool.pool)).not.toContain(R_ENRICHMENT_ERROR);
    });
  });

  // --- §6.3 facets -----------------------------------------------------------

  describe("facets (§6.3)", () => {
    it("cuisines: union of the author column and the label dimension, deduped, sorted by label", async () => {
      const { facets } = await randomizer.readRandomizerPool(db!, DID_A, HH_A, {});
      const slugs = facets.cuisines.map((f) => f.slug);
      expect(slugs).toContain("italian");
      expect(slugs).toContain("mexican");
      expect(new Set(slugs).size).toBe(slugs.length); // deduped: italian appears via both R_IT_AUTHOR AND R_IT_LABEL
      const labels = facets.cuisines.map((f) => f.label);
      expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    });

    it("diets: EXCLUDES gluten_free and dairy_free even though a recipe carries that label", async () => {
      const { facets } = await randomizer.readRandomizerPool(db!, DID_A, HH_A, {});
      const slugs = facets.diets.map((f) => f.slug);
      expect(slugs).toContain("vegetarian");
      expect(slugs).toContain("vegan");
      expect(slugs).toContain("keto");
      // Both halves of the exclusion, each backed by a recipe that really
      // carries the label — R_GLUTEN_DIET and R_DAIRY_DIET.
      expect(slugs).not.toContain("gluten_free");
      expect(slugs).not.toContain("dairy_free");
    });

    it("allergens: only contains/may_contain verdicts contribute — not_detected and unknown do not", async () => {
      const { facets } = await randomizer.readRandomizerPool(db!, DID_A, HH_A, {});
      const slugs = facets.allergens.map((f) => f.slug);
      expect(slugs).toContain("peanut"); // via R_PEANUT_CONTAINS
      expect(slugs).toContain("milk"); // via R_MILK_MAYCONTAIN
      // The load-bearing half. `peanut` cannot prove the verdict predicate is
      // doing anything — R_PEANUT_CONTAINS puts it in the list either way.
      // `soy` (not_detected) and `egg` (unknown) exist in the box with NO
      // positive verdict anywhere, so they are the two slugs that appear if
      // and only if the `verdict in ('contains','may_contain')` filter is
      // dropped. Offering either would be an Avoid… option that excludes
      // nothing.
      expect(slugs).not.toContain("soy");
      expect(slugs).not.toContain("egg");
      expect(slugs.filter((s) => s === "peanut").length).toBe(1); // deduped across three verdicts
    });

    it("mealTypes: canonical order, not alphabetical, and only slugs present", async () => {
      const { facets } = await randomizer.readRandomizerPool(db!, DID_A, HH_A, {});
      // The fixture carries breakfast, lunch and dinner. Canonical order is
      // breakfast → lunch → dinner; ALPHABETICAL order would be breakfast,
      // dinner, lunch. The two disagree, which is the only reason this
      // assertion can tell `MEAL_TYPE_ORDER` from `[...slugs].sort()`.
      expect(facets.mealTypes.map((f) => f.slug)).toEqual(["breakfast", "lunch", "dinner"]);
    });

    it("spiceLevels: canonical order (mild, medium, hot), medium absent when nothing carries it", async () => {
      const { facets } = await randomizer.readRandomizerPool(db!, DID_A, HH_A, {});
      expect(facets.spiceLevels.map((f) => f.slug)).toEqual(["mild", "hot"]);
    });

    it("facets are computed over SCOPE, not the filtered pool — options never vanish as filters narrow", async () => {
      const narrowed = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { cuisine: "mexican" });
      // Even though this pool has no vegetarian/vegan recipe in it, the facet
      // list still offers them — computed over the whole box, not this result.
      expect(narrowed.facets.diets.map((f) => f.slug)).toContain("vegetarian");
    });
  });

  // --- §2.1 cuisine ------------------------------------------------------------

  describe("cuisine filter (§2.1)", () => {
    it("matches via the author column", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { cuisine: "mexican" });
      expect(ids(pool.pool)).toEqual(expect.arrayContaining([R_MX]));
      expect(ids(pool.pool)).not.toContain(R_IT_AUTHOR);
    });

    it("matches via the enrichment label", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { cuisine: "italian" });
      expect(ids(pool.pool)).toEqual(expect.arrayContaining([R_IT_LABEL]));
    });

    it("matches via EITHER — one filter, one slug, both sources", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { cuisine: "italian" });
      expect(ids(pool.pool)).toEqual(expect.arrayContaining([R_IT_AUTHOR, R_IT_LABEL, R_UNTIMED_IT, R_COMBO]));
      expect(ids(pool.pool)).not.toContain(R_MX);
    });
  });

  // --- §2.3 cook time ------------------------------------------------------------

  describe("cook time (§2.3)", () => {
    it("filters total_time_seconds <= maxCookMinutes * 60, excluding untimed recipes by default", async () => {
      // Of the four italian-flavored fixture recipes: R_IT_AUTHOR is 30m and
      // R_COMBO is ~17m (both <= 35m); R_IT_LABEL is 42m (over) and
      // R_UNTIMED_IT has no time at all (excluded by default).
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { cuisine: "italian", maxCookMinutes: 35 });
      expect(ids(pool.pool).sort()).toEqual([R_COMBO, R_IT_AUTHOR].sort());
    });

    it("includeUntimed keeps NULL-time recipes eligible", async () => {
      const without = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { cuisine: "italian", maxCookMinutes: 10 });
      expect(ids(without.pool)).not.toContain(R_UNTIMED_IT);

      const withUntimed = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { cuisine: "italian", maxCookMinutes: 10, includeUntimed: true });
      expect(ids(withUntimed.pool)).toContain(R_UNTIMED_IT);
    });

    it("excludes the slow recipe from a tight window and includes it in a loose one", async () => {
      const tight = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { maxCookMinutes: 60 });
      expect(ids(tight.pool)).not.toContain(R_SLOW);
      const loose = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { maxCookMinutes: 150 });
      expect(ids(loose.pool)).toContain(R_SLOW);
    });
  });

  // --- §4.4 ingredient search ------------------------------------------------

  describe("ingredient search (§4.4)", () => {
    it("is case-insensitive", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { ingredient: "CHICKEN" });
      expect(ids(pool.pool)).toEqual([R_MIXED_CASE]);
    });

    it("a literal '%' is escaped: matches only the recipe that actually contains one, not everything", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { ingredient: "%" });
      expect(ids(pool.pool)).toEqual([R_PERCENT]);
      expect(pool.pool.length).toBeLessThan(HH_A_RECIPES.length);
    });

    it("a literal '_' is escaped: matches only the recipe that actually contains one", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { ingredient: "_" });
      expect(ids(pool.pool)).toEqual([R_UNDERSCORE]);
    });

    it("a literal backslash is escaped and the ESCAPE clause really is '\\': matches the one recipe whose text contains one", async () => {
      // `escapeLikePattern` doubles the backslash and the fragment pins
      // `escape '\\'` — the third character of the §4.4 contract, and the one
      // that proves the ESCAPE clause parses as a single backslash rather
      // than something Postgres reads as an empty or two-character escape.
      const hit = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { ingredient: "a\\b" });
      expect(ids(hit.pool)).toEqual([R_BACKSLASH]);

      // Two literal backslashes are NOT in the stored text ("a\\b sauce" holds
      // exactly one), so this must miss. It matches only if the doubling in
      // `escapeLikePattern` is being un-done somewhere between here and the
      // driver.
      const miss = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { ingredient: "a\\\\b" });
      expect(ids(miss.pool)).toEqual([]);
    });

    it("an ordinary substring still matches normally", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { ingredient: "flour" });
      expect(ids(pool.pool)).toEqual([R_UNDERSCORE]);
    });
  });

  // --- §4.2 enrichment predicates ---------------------------------------------

  describe("meal type / spice level / diet / allergen (§4.2)", () => {
    it("meal type is a single-select EXISTS", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { mealType: "breakfast" });
      expect(ids(pool.pool)).toEqual([R_BREAKFAST]);
    });

    it("spice level is a single-select EXISTS", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { spiceLevel: "hot" });
      expect(ids(pool.pool)).toEqual([R_HOT]);
    });

    it("diets: every requested slug must be likely (AND, not OR)", async () => {
      const onlyVegan = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { diets: ["vegan"] });
      expect(ids(onlyVegan.pool)).toContain(R_VEGAN_KETO);
      expect(ids(onlyVegan.pool)).not.toContain(R_VEG); // vegetarian only, not vegan

      const veganAndKeto = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { diets: ["vegan", "keto"] });
      expect(ids(veganAndKeto.pool)).toEqual([R_VEGAN_KETO]);

      const veganAndVegetarian = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { diets: ["vegan", "vegetarian"] });
      // No recipe in the fixture carries BOTH — AND means neither R_VEG nor
      // R_VEGAN_KETO alone satisfies it.
      expect(ids(veganAndVegetarian.pool)).toEqual([]);
    });

    it("the allergen filter keeps not_detected, keeps unknown, and keeps no-row recipes — the §4.2 asymmetry, asserted directly", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { avoidAllergens: ["peanut"] });
      const found = ids(pool.pool);
      expect(found).not.toContain(R_PEANUT_CONTAINS); // excluded: a real positive
      expect(found).toContain(R_PEANUT_NOTDETECTED); // kept: not a safety claim
      expect(found).toContain(R_PEANUT_UNKNOWN); // kept
      expect(found).toContain(R_NO_ALLERGEN_ROW); // kept: absence is not "free of"
    });

    it("diets require verdict 'likely' — an `excluded` verdict is a miss, not a match", async () => {
      // The diet dimension's verdicts are excluded | likely | unknown. Only
      // `likely` may satisfy the filter (§4.2); `excluded` asserts the
      // opposite and must never be read as a match by dropping the verdict
      // predicate and matching on dimension+slug alone.
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { diets: ["vegan"] });
      expect(ids(pool.pool)).toContain(R_VEGAN_KETO);
      expect(ids(pool.pool)).not.toContain(R_VEGAN_EXCLUDED);
    });

    it("avoidAllergens excludes on ANY listed slug matching contains/may_contain", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { avoidAllergens: ["peanut", "milk"] });
      const found = ids(pool.pool);
      expect(found).not.toContain(R_PEANUT_CONTAINS);
      expect(found).not.toContain(R_MILK_MAYCONTAIN);
    });
  });

  // --- §4.6 recency ------------------------------------------------------------

  describe("recency — skip what we've had (§4.6)", () => {
    it("defaults ON at 14 days and hides a recently-planned recipe", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, {});
      expect(ids(pool.pool)).not.toContain(R_RECENT_PLAN);
      expect(ids(pool.pool)).toContain(R_OLD_PLAN); // outside the 14-day window
      expect(pool.skippedRecent).toBe(1);
    });

    it("skipRecentDays: null turns the filter off entirely", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { skipRecentDays: null });
      expect(ids(pool.pool)).toContain(R_RECENT_PLAN);
      expect(pool.skippedRecent).toBe(0);
    });

    it("a custom window changes what counts as recent", async () => {
      // OLD_DATE is -30 days; a 45-day window should now hide it too.
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { skipRecentDays: 45 });
      expect(ids(pool.pool)).not.toContain(R_OLD_PLAN);
      expect(ids(pool.pool)).not.toContain(R_RECENT_PLAN);
    });

    it("the window boundary is INCLUSIVE: a meal planned exactly N days ago is still 'recent'", async () => {
      // §4.6's predicate is `plan_date >= today::date - N`, so day N itself is
      // inside the window and day N+1 is outside. The rest of this group works
      // at -3 and -30, which never touches the boundary either way.
      const entryId = `${RUN}-mpe-boundary`;
      await db!
        .insertInto("meal_plan_entry")
        .values({ id: entryId, household_id: HH_A, plan_date: shiftDays(today, -14), slot: "dinner", kind: "recipe", position: 0, recipe_id: R_MX, created_by_did: DID_A })
        .execute();
      try {
        const atBoundary = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { skipRecentDays: 14 });
        expect(ids(atBoundary.pool)).not.toContain(R_MX);
        expect(atBoundary.skippedRecent).toBe(2); // R_RECENT_PLAN (-3) and R_MX (-14)

        const justInside = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { skipRecentDays: 13 });
        expect(ids(justInside.pool)).toContain(R_MX); // 14 days ago is outside a 13-day window
        expect(justInside.skippedRecent).toBe(1);
      } finally {
        await db!.deleteFrom("meal_plan_entry").where("id", "=", entryId).execute();
      }
    });

    it("hides a recipe planned for a FUTURE date too — the window has no upper bound", async () => {
      // §4.6's predicate is one-sided (`plan_date >= today - N`), so anything
      // already on the plan for a coming day is out of the draw as well. That
      // is the behaviour the spec's SQL specifies; pinned here so a later
      // `between` never quietly starts suggesting tomorrow's dinner tonight.
      const entryId = `${RUN}-mpe-future`;
      await db!
        .insertInto("meal_plan_entry")
        .values({ id: entryId, household_id: HH_A, plan_date: shiftDays(today, 3), slot: "dinner", kind: "recipe", position: 0, recipe_id: R_MX, created_by_did: DID_A })
        .execute();
      try {
        const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, {});
        expect(ids(pool.pool)).not.toContain(R_MX);
      } finally {
        await db!.deleteFrom("meal_plan_entry").where("id", "=", entryId).execute();
      }
    });

    it("ignores a soft-deleted plan entry even though it is inside the window", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, {});
      expect(ids(pool.pool)).toContain(R_SOFT_DELETED_RECENT);
    });

    it("anchors 'today' on the HOUSEHOLD's timezone: the same stored plan_date reads as recent under one zone and not under another", async () => {
      // Two zones 26 hours apart — per `meal-plan.db.test.ts`'s own precedent,
      // their calendar dates ALWAYS differ, so this needs no wall-clock luck.
      const ahead = "Pacific/Kiritimati"; // UTC+14
      const behind = "Etc/GMT+12"; // UTC-12
      const dateAhead = todayIn(ahead);
      const dateBehind = todayIn(behind);
      expect(dateBehind < dateAhead).toBe(true);

      // One entry, dated exactly `behind`'s today. Filed against R_OLD_PLAN,
      // which already carries an unrelated far-past entry (EXISTS semantics
      // mean either entry alone can hide it — that is what makes this
      // assertion about THIS entry specifically, not a coincidence of the
      // fixture).
      const entryId = `${RUN}-mpe-tz-boundary`;
      await db!
        .insertInto("meal_plan_entry")
        .values({ id: entryId, household_id: HH_A, plan_date: dateBehind, slot: "snack", kind: "recipe", position: 0, recipe_id: R_OLD_PLAN, created_by_did: DID_A })
        .execute();
      try {
        // skipRecentDays: 0 — "only exactly today counts as recent" — makes the
        // household's own notion of "today" the whole test.
        await prefs.writeHouseholdPreferences(HH_A, { weekStartDay: 1, timezone: behind });
        const asBehind = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { skipRecentDays: 0 });
        expect(ids(asBehind.pool)).not.toContain(R_OLD_PLAN); // dateBehind IS "today" under `behind` → hidden

        await prefs.writeHouseholdPreferences(HH_A, { weekStartDay: 1, timezone: ahead });
        const asAhead = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { skipRecentDays: 0 });
        expect(ids(asAhead.pool)).toContain(R_OLD_PLAN); // dateBehind is YESTERDAY under `ahead` → visible
      } finally {
        await db!.deleteFrom("meal_plan_entry").where("id", "=", entryId).execute();
        await prefs.writeHouseholdPreferences(HH_A, { weekStartDay: 1, timezone: HH_A_ZONE });
      }
    });
  });

  // --- collection + favorites scoping ------------------------------------------

  describe("collection and favourites scoping", () => {
    it("collectionId scopes totalInScope and the pool to just that collection's members", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { collectionId: COLLECTION_ID });
      expect(pool.totalInScope).toBe(1);
      expect(ids(pool.pool)).toEqual([R_IN_COLLECTION]);
    });

    it("a collection id belonging to ANOTHER household selects nothing, even for a recipe both boxes hold", async () => {
      // The `EXISTS` carries `rce.household_id = $householdId` as well as the
      // collection id. Drop that column and this leaks: R_MX is in HH_A's box
      // AND in a collection HH_B owns, so HH_A asking for HH_B's collection id
      // would get it back.
      const foreignCollection = `col-b-${RUN}`;
      await db!.insertInto("household_recipe").values({ household_id: HH_B, recipe_id: R_MX, added_by_did: DID_B }).execute();
      await db!.insertInto("recipe_collection").values({ id: foreignCollection, household_id: HH_B, name: "B's Collection", position: 0, created_by_did: DID_B }).execute();
      await db!.insertInto("recipe_collection_entry").values({ collection_id: foreignCollection, household_id: HH_B, recipe_id: R_MX, position: 0, added_by_did: DID_B }).execute();
      try {
        const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { collectionId: foreignCollection });
        expect(pool.totalInScope).toBe(0);
        expect(ids(pool.pool)).toEqual([]);

        // Positive control: HH_B's own member DOES see it through that id.
        const asOwner = await randomizer.readRandomizerPool(db!, DID_B, HH_B, { collectionId: foreignCollection });
        expect(ids(asOwner.pool)).toEqual([R_MX]);
      } finally {
        await db!.deleteFrom("recipe_collection_entry").where("collection_id", "=", foreignCollection).execute();
        await db!.deleteFrom("recipe_collection").where("id", "=", foreignCollection).execute();
        await db!.deleteFrom("household_recipe").where("household_id", "=", HH_B).where("recipe_id", "=", R_MX).execute();
      }
    });

    it("favoritesOnly narrows to hr.favorite = true", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { favoritesOnly: true });
      expect(ids(pool.pool)).toEqual([R_FAVORITE]);
      expect(pool.pool[0].favorite).toBe(true);
    });
  });

  // --- AND-combined -------------------------------------------------------------

  describe("filters AND-combine", () => {
    it("cuisine + diet + time + avoid-allergen together narrow to exactly one recipe", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, {
        cuisine: "italian",
        diets: ["vegetarian"],
        maxCookMinutes: 20,
        avoidAllergens: ["peanut"],
      });
      expect(ids(pool.pool)).toEqual([R_COMBO]);
    });
  });

  // --- §4.5 corpus source --------------------------------------------------------

  describe("corpus source (§4.5)", () => {
    it("excludes already-boxed recipes and drafts, keeps genuinely new public recipes", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { source: "corpus" });
      const found = ids(pool.pool);
      expect(found).toContain(R_CORPUS_PUBLIC);
      expect(found).not.toContain(R_CORPUS_BOXED);
      expect(found).not.toContain(R_CORPUS_DRAFT);
    });

    it("the anti-join is scoped to THIS household — a recipe another household boxed is still new here", async () => {
      // §4.5's anti-join is `not exists (… hr2.household_id = $householdId)`.
      // Drop the household column and it becomes "in ANY box", which would
      // hide from every household every recipe any other household has ever
      // kept — the corpus would empty out as the app grew.
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { source: "corpus" });
      expect(ids(pool.pool)).toContain(R_CORPUS_OTHERBOX); // boxed by HH_B, never by HH_A
      expect(ids(pool.pool)).not.toContain(R_CORPUS_BOXED); // boxed by HH_A itself

      // And symmetrically from HH_B's side, so this cannot pass by the
      // anti-join being broken in the other direction.
      const asB = await randomizer.readRandomizerPool(db!, DID_B, HH_B, { source: "corpus" });
      expect(ids(asB.pool)).not.toContain(R_CORPUS_OTHERBOX);
      expect(ids(asB.pool)).toContain(R_CORPUS_BOXED);
    });

    it("every corpus card reports favorite: false, with no household_recipe row to read it from", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { source: "corpus" });
      expect(pool.pool.every((card) => card.favorite === false)).toBe(true);
    });

    it("caps the pool at CORPUS_POOL_CAP and reports capped: true", async () => {
      const capIds = Array.from({ length: randomizer.CORPUS_POOL_CAP + 5 }, (_, i) => `r-cap-${i}-${RUN}`);
      await db!
        .insertInto("recipe")
        .values(capIds.map((id) => ({ id, origin: "local", visibility: "public", name: `Cap Filler ${id}` })))
        .execute();
      try {
        const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { source: "corpus" });
        expect(pool.capped).toBe(true);
        expect(pool.pool.length).toBe(randomizer.CORPUS_POOL_CAP);
        expect(pool.cap).toBe(randomizer.CORPUS_POOL_CAP);
      } finally {
        await db!.deleteFrom("recipe").where("id", "in", capIds).execute();
      }
    });

    it("samples the capped pool at random rather than taking an alphabetical prefix", async () => {
      // The cap is the one place the corpus branch can silently bias a
      // RANDOMIZER. Ordered by name, a corpus larger than the cap makes every
      // recipe sorting past the 200th permanently undrawable — the surface
      // would quietly refuse to suggest anything after roughly the letter B,
      // and `capped: true` would be the only hint. Two reads of the same
      // filters must therefore be able to disagree about WHICH matches they
      // return.
      //
      // Names are deliberately zero-padded and ascending, so an alphabetical
      // cap is a stable prefix: under `order by r.name` both reads return
      // exactly ids 000…199 and this test fails. Flakiness is bounded — two
      // uniform 200-of-260 samples collide entirely with probability far
      // below 1e-30 — but the assertion is on the UNION rather than on
      // inequality of the two sets, so it says the thing it means: across two
      // reads, more than a cap's worth of distinct recipes are reachable.
      const total = randomizer.CORPUS_POOL_CAP + 60;
      const capIds = Array.from({ length: total }, (_, i) => `r-sample-${String(i).padStart(4, "0")}-${RUN}`);
      await db!
        .insertInto("recipe")
        .values(capIds.map((id, i) => ({ id, origin: "local", visibility: "public", name: `Sample ${String(i).padStart(4, "0")}` })))
        .execute();
      try {
        const [first, second] = await Promise.all([
          randomizer.readRandomizerPool(db!, DID_A, HH_A, { source: "corpus" }),
          randomizer.readRandomizerPool(db!, DID_A, HH_A, { source: "corpus" }),
        ]);
        expect(first.capped).toBe(true);
        const union = new Set([...first.pool.map((c) => c.recipeId), ...second.pool.map((c) => c.recipeId)]);
        expect(union.size).toBeGreaterThan(randomizer.CORPUS_POOL_CAP);
      } finally {
        await db!.deleteFrom("recipe").where("id", "in", capIds).execute();
      }
    });

    it("reports capped: false and never caps a box draw", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_A, HH_A, {});
      expect(pool.capped).toBe(false);
      expect(pool.cap).toBe(randomizer.CORPUS_POOL_CAP);
    });
  });

  // --- household scoping — the membership join is the authorization -----------

  describe("household scoping — fail closed", () => {
    it("a non-member of the household reads an empty scope, not another household's box", async () => {
      const pool = await randomizer.readRandomizerPool(db!, DID_B, HH_A, {});
      expect(pool.totalInScope).toBe(0);
      expect(pool.pool).toEqual([]);
      expect(pool.facets.cuisines).toEqual([]);

      // Positive control on the same call, so an assertion that would hold for
      // an always-empty implementation cannot pass for the wrong reason.
      const asMember = await randomizer.readRandomizerPool(db!, DID_A, HH_A, {});
      expect(asMember.totalInScope).toBeGreaterThan(0);
    });

    it("EVERY aggregate is scoped by the membership join, not just the pool", async () => {
      // An unscoped `totalInScope` / `unenrichedInScope` / `skippedRecent` /
      // facet query would leak counts across households even with a clean
      // pool, so each one is asserted at zero for a non-member and non-zero
      // for a member of the same household.
      const outsider = await randomizer.readRandomizerPool(db!, DID_B, HH_A, {});
      expect(outsider).toMatchObject({ totalInScope: 0, unenrichedInScope: 0, skippedRecent: 0 });
      expect(outsider.facets).toEqual({ cuisines: [], diets: [], allergens: [], mealTypes: [], spiceLevels: [] });

      const member = await randomizer.readRandomizerPool(db!, DID_A, HH_A, {});
      expect(member.unenrichedInScope).toBe(2);
      expect(member.skippedRecent).toBe(1);
      expect(member.facets.cuisines.length).toBeGreaterThan(0);
    });

    it("the CORPUS path fails closed for a non-member too — it has no membership join to hide behind", async () => {
      // `source: "corpus"` scans `recipe` directly; `householdId` only feeds
      // the box anti-join and the `skippedRecent` count off `meal_plan_entry`.
      // Without an explicit membership check a stranger holding this household
      // id would get a full pool AND learn, by omission from the anti-join,
      // which public recipes this household has boxed.
      const outsider = await randomizer.readRandomizerPool(db!, DID_B, HH_A, { source: "corpus" });
      expect(outsider.source).toBe("corpus");
      expect(outsider.pool).toEqual([]);
      expect(outsider).toMatchObject({ totalInScope: 0, unenrichedInScope: 0, skippedRecent: 0, capped: false });
      expect(outsider.facets).toEqual({ cuisines: [], diets: [], allergens: [], mealTypes: [], spiceLevels: [] });

      // Positive control: the same household id in a real member's hands does
      // return the corpus, so the assertion above is about membership and not
      // about the corpus branch being broken outright.
      const member = await randomizer.readRandomizerPool(db!, DID_A, HH_A, { source: "corpus" });
      expect(ids(member.pool)).toContain(R_CORPUS_PUBLIC);
    });
  });
});
