import { createServerFn } from "@tanstack/react-start";
import type { Kysely, RawBuilder, SelectQueryBuilder, Sql } from "kysely";
import * as z from "zod";
import type { DB } from "#/db/types";
import { blobImageUrl } from "#/lib/atproto/images";
import type { PlanDate } from "#/lib/plan/week";
import { todayIn } from "#/lib/plan/week";
import { escapeLikePattern } from "#/lib/randomizer/escape-like";
import { deriveSource, prettify } from "#/lib/recipe-provenance";
import type { RandomizerCard, RandomizerFacetOption, RandomizerFacets, RandomizerFilters, RandomizerPool } from "#/lib/api/types";

/**
 * The randomizer's one server function (meal randomizer plan §4, all
 * subsections, and §10's `readRandomizerPool` bullet). Read-only over the
 * existing box / enrichment / meal-plan tables — no new table, no write.
 *
 * Same shape as `server/meal-plan.ts` and `server/grocery.ts`: a thin
 * `createServerFn` wrapper resolves the caller DID + active household from
 * the server-validated session and gates through `assertMember`, then
 * delegates to a plain exported `readRandomizerPool(db, did, householdId,
 * input)` that holds ALL of the behaviour — so `randomizer.db.test.ts` can
 * reach it without faking a session, and the wrapper stays the only place
 * `active_household_id` is read.
 *
 * Server-only imports (`getDb`, kysely `sql`, authz/session) are pulled in
 * with dynamic `import()` inside the handler and inside `readRandomizerPool`,
 * matching every other module here — this file stays safe to reference from
 * the client bundle. `Kysely` / `RawBuilder` / `SelectQueryBuilder` / `Sql`
 * are TYPE-only imports (erased at compile time), so they are safe at module
 * top level the same way `meal-plan.ts` keeps `import type { Kysely }` there.
 *
 * ── WHY EVERY PREDICATE BELOW IS A RAW `sql` FRAGMENT, NOT `eb(...)` ────────
 * The box query (joined through `household_member`/`household`/
 * `household_recipe`/`recipe`) and the corpus query (`recipe` alone) have
 * genuinely different Kysely table-alias sets (`TB`). Sharing one predicate
 * function across both would need `TB` widened to `any`, and Kysely's typed
 * `eb(ref, op, value)` / `eb.exists(...)` builders need a REAL `TB` to
 * resolve a column's value type — widen it and every value comparison stops
 * type-checking (verified: it fails to compile). A raw `sql<boolean>\`…\``
 * fragment carries no `TB` at all (`Expression<SqlBool>` isn't parameterized
 * by it), so `.where(fragment)` type-checks identically against BOTH query
 * shapes, and one set of predicate functions serves both scope branches — the
 * same reuse `$if` would have bought, without needing it. Every value in a
 * fragment below is still a bound parameter via the `sql` tag (never string
 * interpolation into the query text), so this is a typing choice, not a
 * safety one.
 */

// --- shared shapes --------------------------------------------------------

/**
 * The wire DTOs this module returns are declared in the port's `types.ts`
 * (offline plan §4.3 / §7) and imported from there. Re-exported here for
 * server-side callers that reach for them through this module. NOTE: the
 * randomizer itself is deliberately online-only (plan §1.2) — these types
 * cross the wire, but the pool is never persisted to IndexedDB the way the
 * box or the plan are.
 */
export type { RandomizerCard, RandomizerFacetOption, RandomizerFacets, RandomizerFilters, RandomizerPool };

// --- tuning constants (plan §4.1, §4.5, §4.6) ------------------------------

/** §4.1: "ingredient sliced to ~200 chars". */
const INGREDIENT_MAX_CHARS = 200;
/** §4.1: every slug capped so a hostile client can't stuff megabytes into a `WHERE … IN`. */
const SLUG_MAX_CHARS = 64;
/** §4.1: "diets/avoidAllergens capped in length". */
const SLUG_LIST_MAX = 20;
/**
 * Collection ids are app ULIDs (`ulid()` in `server/household/ids.ts`), not
 * enrichment slugs — they were already clamped to 128 chars as a single
 * value before `collectionIds` existed, so that per-id bound carries over
 * unchanged. The list itself is capped at `SLUG_LIST_MAX`, same as
 * `diets`/`avoidAllergens`: no stated reason a household would ever
 * multi-select more collections than diets, so there is no reason to give
 * this list a different ceiling than the others it sits beside in the
 * clamp pass.
 */
const COLLECTION_ID_MAX_CHARS = 128;
/** §4.1: "maxCookMinutes a positive finite number" — clamp to a sane outer bound (a day). No real recipe legitimately needs more; this only bounds a hostile value. */
const MAX_COOK_MINUTES_CEILING = 24 * 60;
/** §4.6: "Default ON at 14 days." */
const DEFAULT_SKIP_RECENT_DAYS = 14;
/** §4.1: "skipRecentDays bounded (0–90)". */
const SKIP_RECENT_DAYS_MAX = 90;
/** §4.5: "Cap the pool (200)". */
export const CORPUS_POOL_CAP = 200;

/** §6.3: meal_type facet order — an ordered set, not an alphabetical list. */
const MEAL_TYPE_ORDER = ["breakfast", "lunch", "dinner", "dessert", "snack", "side", "drink"];
/** §6.3: spice_level facet order. */
const SPICE_LEVEL_ORDER = ["mild", "medium", "hot"];
/** §6.3: these two diet slugs are served by the Avoid… allergen control, not the Diets facet. */
const DIET_FACET_EXCLUDED = new Set(["gluten_free", "dairy_free"]);

// --- input clamping (§4.1) -------------------------------------------------

/**
 * The normalized, fully-clamped shape every query builder below reads. Never
 * trusts the caller's raw `RandomizerFilters` directly — normalized HERE, not
 * by the zod validator, so `readRandomizerPool` is safe to call directly (as
 * the db test suite does) without going through `getRandomizerPool`'s
 * validator at all.
 */
interface NormalizedFilters {
  source: "box" | "corpus";
  /** ORed (§2's `collectionIds` doc): a recipe qualifies if it sits in ANY listed collection. Empty = no filter, never "match nothing". */
  collectionIds: string[];
  favoritesOnly: boolean;
  cuisine: string | null;
  maxCookMinutes: number | null;
  includeUntimed: boolean;
  ingredient: string | null;
  mealType: string | null;
  diets: string[];
  avoidAllergens: string[];
  spiceLevel: string | null;
  /** null = the recency filter is off. */
  skipRecentDays: number | null;
}

/** Trim + cap one slug-ish string to `maxChars`; `null` for anything empty or not a string. */
function clampString(raw: unknown, maxChars: number): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, maxChars);
  return trimmed.length > 0 ? trimmed : null;
}

/** Trim + cap one slug-ish string; `null` for anything empty or not a string. */
function clampSlug(raw: unknown): string | null {
  return clampString(raw, SLUG_MAX_CHARS);
}

/** Clamp (to `maxChars` each) + de-dupe + cap-length (to `SLUG_LIST_MAX`) a string array. */
function clampStringList(raw: unknown, maxChars: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const value = clampString(entry, maxChars);
    if (value && !out.includes(value)) out.push(value);
    if (out.length >= SLUG_LIST_MAX) break;
  }
  return out;
}

/** Clamp + de-dupe + cap-length a slug array. Never longer than `SLUG_LIST_MAX`. */
function clampSlugList(raw: unknown): string[] {
  return clampStringList(raw, SLUG_MAX_CHARS);
}

function normalizeFilters(input: RandomizerFilters): NormalizedFilters {
  const maxCookMinutesRaw = input.maxCookMinutes;
  const maxCookMinutes =
    typeof maxCookMinutesRaw === "number" && Number.isFinite(maxCookMinutesRaw) && maxCookMinutesRaw > 0 ? Math.min(maxCookMinutesRaw, MAX_COOK_MINUTES_CEILING) : null;

  const skipRecentDaysRaw = input.skipRecentDays;
  const skipRecentDays =
    skipRecentDaysRaw === null
      ? null // explicit off (§4.1: "null = off")
      : skipRecentDaysRaw === undefined
        ? DEFAULT_SKIP_RECENT_DAYS
        : typeof skipRecentDaysRaw === "number" && Number.isFinite(skipRecentDaysRaw)
          ? Math.max(0, Math.min(Math.round(skipRecentDaysRaw), SKIP_RECENT_DAYS_MAX))
          : DEFAULT_SKIP_RECENT_DAYS;

  const ingredientRaw = typeof input.ingredient === "string" ? input.ingredient.slice(0, INGREDIENT_MAX_CHARS).trim() : "";

  return {
    source: input.source === "corpus" ? "corpus" : "box",
    collectionIds: clampStringList(input.collectionIds, COLLECTION_ID_MAX_CHARS),
    favoritesOnly: input.favoritesOnly === true,
    cuisine: clampSlug(input.cuisine),
    maxCookMinutes,
    // Default TRUE (types.ts `RandomizerFilters.includeUntimed` doc, and the
    // user override of plan §2.3): only ~49% of a real box carries
    // `total_time_seconds`, so defaulting this off meant touching the time
    // chip at all silently halved the shelf. Only an explicit `false` turns
    // untimed recipes back off — do not "fix" this back to `=== true`.
    includeUntimed: input.includeUntimed !== false,
    ingredient: ingredientRaw.length > 0 ? ingredientRaw : null,
    mealType: clampSlug(input.mealType),
    diets: clampSlugList(input.diets),
    avoidAllergens: clampSlugList(input.avoidAllergens),
    spiceLevel: clampSlug(input.spiceLevel),
    skipRecentDays,
  };
}

// --- session / card-mapping helpers -----------------------------------------

/**
 * Resolve `{ did, householdId }` for a household-scoped handler. Mirrors
 * `server/meal-plan.ts` / `server/grocery.ts` / `server/household-recipes.ts`
 * verbatim rather than importing one of theirs: every other module in this
 * directory carries its own copy of this exact function (it is a five-line
 * session read, not shared logic), and a randomizer-specific import from
 * `household-recipes.ts` would be a stranger coupling than duplicating five
 * lines that never change.
 */
async function activeContext(): Promise<{ did: string; householdId: string }> {
  const { getServerSession } = await import("./household/session");
  const { NotAMemberError } = await import("./household/errors");
  const { redirect } = await import("@tanstack/react-router");
  const session = await getServerSession();
  const did = session?.user.did ?? null;
  if (!did) throw redirect({ to: "/login" });
  const householdId = session?.session.active_household_id ?? null;
  if (!householdId) throw new NotAMemberError();
  return { did, householdId };
}

/** total_time_seconds → { minutes, display } ("1h 30m" / "45m"). Mirrors `household-recipes.ts` / `meal-plan.ts`. */
function minutesDisplay(totalSeconds: number | null | undefined): { minutes: number | null; display: string | null } {
  if (!totalSeconds || totalSeconds <= 0) return { minutes: null, display: null };
  const minutes = Math.round(totalSeconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const display = h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  return { minutes, display };
}

/** One card row, exactly the columns `listHouseholdRecipes`'s card mapping reads (§4.4: "the same fields `HouseholdRecipeRow` carries"). */
interface CardRow {
  id: string;
  name: string;
  origin: string;
  did: string | null;
  total_time_seconds: number | null;
  blob_cid: string | null;
  blob_mime: string | null;
  attr_display_name: string | null;
  attr_author: string | null;
  attr_publisher: string | null;
  attr_url: string | null;
  repo_handle: string | null;
}

/**
 * `CardRow` (+ whether it's favorited) → the wire `RandomizerCard`. `favorite`
 * is passed separately rather than read off the row because the corpus query
 * has no `household_recipe` row to read it from at all (§4.5: "Drop
 * [favorite]. There is no row to set it on until the recipe is kept.").
 */
function toCard(row: CardRow, favorite: boolean): RandomizerCard {
  const { minutes, display } = minutesDisplay(row.total_time_seconds);
  const source = deriveSource({
    repoHandle: row.repo_handle,
    attrDisplayName: row.attr_display_name,
    attrAuthor: row.attr_author,
    attrPublisher: row.attr_publisher,
    attrUrl: row.attr_url,
  });
  return {
    recipeId: row.id,
    title: row.name,
    sourceKind: source?.kind ?? null,
    sourceLabel: source?.label ?? null,
    sourceUrl: source?.url ?? null,
    totalMinutes: minutes,
    totalTimeDisplay: display,
    thumbUrl: row.did && row.blob_cid ? blobImageUrl(row.did, row.blob_cid, row.blob_mime, "feed_thumbnail") : null,
    favorite,
  };
}

// --- facet labelling (§6.3) -------------------------------------------------

/**
 * `recipe_vocab` label for every slug of one dimension, bounded to exactly
 * the slugs present in scope.
 *
 * There is no runtime query against `recipe_vocab` anywhere else in this
 * codebase — `lib/recipe-vocab.ts` mirrors it client-side, but only for
 * `cuisine`/`category`/`cooking_method`/`diet`, not `meal_type` or
 * `spice_level`. `server/recipe-enrichment.ts`'s module doc explicitly
 * anticipates this: a caller that needs the full grid "must do its own
 * bounded join against `recipe_vocab`, scoped to the slugs it knows
 * `classifierVersion` covers". That is exactly this call: the slugs passed in
 * are precisely the ones the facet aggregate queries above found PRESENT in
 * scope, for the one dimension being labelled, and nothing wider. This one
 * bounded lookup — never a join against a table this module otherwise leaves
 * alone — is the honest source for all five facet dimensions at once
 * (`cuisine`/`diet`/`allergen`/`meal_type`/`spice_level`), rather than a
 * second, hand-maintained label table that could drift from the seeded one.
 *
 * A slug absent from the result (a `recipe_vocab` row that predates a
 * since-removed value — never expected in practice, `recipe_vocab` rows are
 * additive) falls through to `prettify` at the call site, never to a thrown
 * error.
 */
async function vocabLabels(db: Kysely<DB>, dimension: string, slugs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (slugs.length === 0) return out;
  const rows = await db.selectFrom("recipe_vocab").select(["slug", "label"]).where("dimension", "=", dimension).where("slug", "in", slugs).execute();
  for (const row of rows) out.set(row.slug, row.label);
  return out;
}

/** Facet options sorted by label — `cuisines`, `diets`, `allergens` (§6.3: "sorted by label"). */
function labelSortedOptions(slugs: Iterable<string>, labels: Map<string, string>): RandomizerFacetOption[] {
  return [...slugs].map((slug) => ({ slug, label: labels.get(slug) ?? prettify(slug) ?? slug })).sort((a, b) => a.label.localeCompare(b.label));
}

/** Facet options in a fixed canonical order — `mealTypes`, `spiceLevels` (§6.3: "an ordered set, not a list"), filtered to what's actually present. */
function orderedOptions(canonical: string[], present: Set<string>, labels: Map<string, string>): RandomizerFacetOption[] {
  return canonical.filter((slug) => present.has(slug)).map((slug) => ({ slug, label: labels.get(slug) ?? prettify(slug) ?? slug }));
}

// --- §4.2 / §4.4 / §4.6 predicates, as raw sql fragments over `r` ----------
//
// Every function below returns a `RawBuilder<boolean>` bound against the
// outer query's `recipe as r` alias — present in both the box join and the
// bare corpus scan (see the module doc for why this is raw sql rather than
// the typed `eb(...)` builder). Every user-supplied value is a bound `sql`
// parameter; nothing here is ever string-interpolated into the query text.

/** §2.1 cuisine: the author column OR an enrichment label — same `recipe_vocab` dimension either way. No verdict predicate on the label: the check constraint guarantees `verdict = 'likely'` for this dimension (migration 1787783591746's third check arm) — harmless to state again, so it is, for symmetry with the other label predicates below. */
function cuisineWhere(sqlTag: Sql, cuisine: string): RawBuilder<boolean> {
  return sqlTag<boolean>`(r.recipe_cuisine = ${cuisine} or exists (
    select 1 from recipe_enrichment_label cl
    where cl.recipe_id = r.id and cl.dimension = 'cuisine' and cl.slug = ${cuisine} and cl.verdict = 'likely'
  ))`;
}

/** §2.3 max cook time over `total_time_seconds`; untimed recipes excluded unless `includeUntimed` opts them back in. */
function maxCookMinutesWhere(sqlTag: Sql, maxCookMinutes: number, includeUntimed: boolean): RawBuilder<boolean> {
  const capSeconds = maxCookMinutes * 60;
  return includeUntimed ? sqlTag<boolean>`(r.total_time_seconds <= ${capSeconds} or r.total_time_seconds is null)` : sqlTag<boolean>`r.total_time_seconds <= ${capSeconds}`;
}

/** §4.4 ingredient substring — case-insensitive, wildcard-escaped (`lib/randomizer/escape-like.ts`), bound as an opaque parameter. */
function ingredientWhere(sqlTag: Sql, ingredient: string): RawBuilder<boolean> {
  const pattern = `%${escapeLikePattern(ingredient)}%`;
  return sqlTag<boolean>`exists (
    select 1 from recipe_ingredient ri
    where ri.recipe_id = r.id and ri.text ilike ${pattern} escape '\\'
  )`;
}

/** One `dimension = slug` `EXISTS`, with an optional verdict predicate — meal_type / spice_level / one diet slug all use this shape. */
function labelExistsWhere(sqlTag: Sql, dimension: string, slug: string, verdict: string | null): RawBuilder<boolean> {
  return verdict
    ? sqlTag<boolean>`exists (select 1 from recipe_enrichment_label l where l.recipe_id = r.id and l.dimension = ${dimension} and l.slug = ${slug} and l.verdict = ${verdict})`
    : sqlTag<boolean>`exists (select 1 from recipe_enrichment_label l where l.recipe_id = r.id and l.dimension = ${dimension} and l.slug = ${slug})`;
}

/**
 * The allergen filter — an EXCLUSION, not a promise (§4.2, the predicate with
 * teeth). `NOT EXISTS(contains|may_contain for ANY requested slug)` keeps
 * recipes with `not_detected`, with `unknown`, and with NO allergen row at
 * all — a recipe nothing has classified is indistinguishable from one
 * classified clean, exactly like `lib/recipe-tags.ts`'s display-side
 * asymmetry (its module doc: "`not_detected`, `unknown`, and an absent row
 * must NEVER reach the UI as 'free of' or 'safe'"). Do NOT turn this into a
 * positive "free of" filter — only a stored `contains`/`may_contain` verdict
 * ever removes a recipe here.
 */
function avoidAllergensWhere(sqlTag: Sql, slugs: string[]): RawBuilder<boolean> {
  return sqlTag<boolean>`not exists (
    select 1 from recipe_enrichment_label l
    where l.recipe_id = r.id and l.dimension = 'allergen'
      and l.slug = any(${slugs}::text[])
      and l.verdict in ('contains','may_contain')
  )`;
}

/**
 * §4.6: this household planned this recipe on or after `today - skipRecentDays`,
 * live entries only. `today` is `todayIn(timezone)`, never `current_date` —
 * the server's clock is the wrong one (§4.6).
 *
 * `skipRecentDays` is cast `::int` explicitly. Without it, Postgres's
 * extended-protocol parameter typing resolves `date - $N` against the
 * `date - date → integer` overload rather than `date - integer → date`
 * (an unknown-typed parameter apparently prefers the operand-matching
 * overload over the differently-typed one) — the whole subtraction then
 * evaluates to an `integer`, and the outer `plan_date >= …` comparison fails
 * to find a `date >= integer` operator. Verified against a live connection
 * (`pg` directly, bypassing Kysely) before landing this cast.
 */
function recentPlanEntryWhere(sqlTag: Sql, today: PlanDate, skipRecentDays: number, householdId: string): RawBuilder<boolean> {
  return sqlTag<boolean>`exists (
    select 1 from meal_plan_entry mpe
    where mpe.recipe_id = r.id and mpe.household_id = ${householdId}
      and mpe.deleted_at is null and mpe.plan_date >= ${today}::date - ${skipRecentDays}::int
  )`;
}

function notWhere(sqlTag: Sql, expr: RawBuilder<boolean>): RawBuilder<boolean> {
  return sqlTag<boolean>`not (${expr})`;
}

/**
 * §2.1/§2.3/§4.4/§4.6 every filter EXCEPT recency and `favoritesOnly` — those
 * two are applied by the caller (recency needs to be toggled between the
 * `skippedRecent` count and the pool filter; `favoritesOnly` only exists for
 * `source: "box"`). One condition per requested diet slug (every slug must be
 * `likely` — AND, not OR).
 */
function poolConditions(sqlTag: Sql, f: NormalizedFilters): RawBuilder<boolean>[] {
  const conditions: RawBuilder<boolean>[] = [];
  if (f.cuisine) conditions.push(cuisineWhere(sqlTag, f.cuisine));
  if (f.maxCookMinutes != null) conditions.push(maxCookMinutesWhere(sqlTag, f.maxCookMinutes, f.includeUntimed));
  if (f.ingredient) conditions.push(ingredientWhere(sqlTag, f.ingredient));
  if (f.mealType) conditions.push(labelExistsWhere(sqlTag, "meal_type", f.mealType, "likely"));
  if (f.spiceLevel) conditions.push(labelExistsWhere(sqlTag, "spice_level", f.spiceLevel, "likely"));
  for (const slug of f.diets) conditions.push(labelExistsWhere(sqlTag, "diet", slug, "likely"));
  if (f.avoidAllergens.length > 0) conditions.push(avoidAllergensWhere(sqlTag, f.avoidAllergens));
  return conditions;
}

/**
 * The fail-closed answer: an empty pool with every aggregate at zero and every
 * facet empty. Exactly what the box branch's membership join produces for a
 * non-member on its own; returned explicitly for the corpus branch, which has
 * no join to produce it.
 */
function emptyPool(source: "box" | "corpus"): RandomizerPool {
  return {
    source,
    pool: [],
    totalInScope: 0,
    unenrichedInScope: 0,
    skippedRecent: 0,
    capped: false,
    cap: CORPUS_POOL_CAP,
    facets: { cuisines: [], diets: [], allergens: [], mealTypes: [], spiceLevels: [] },
  };
}

// --- §4 getRandomizerPool / readRandomizerPool ------------------------------

const filtersValidator = z
  .object({
    source: z.enum(["box", "corpus"]).optional(),
    collectionIds: z.array(z.string().max(128)).max(SLUG_LIST_MAX).optional(),
    favoritesOnly: z.boolean().optional(),
    cuisine: z.string().max(SLUG_MAX_CHARS).optional(),
    maxCookMinutes: z.number().optional(),
    includeUntimed: z.boolean().optional(),
    ingredient: z.string().max(INGREDIENT_MAX_CHARS).optional(),
    mealType: z.string().max(SLUG_MAX_CHARS).optional(),
    diets: z.array(z.string().max(SLUG_MAX_CHARS)).max(SLUG_LIST_MAX).optional(),
    avoidAllergens: z.array(z.string().max(SLUG_MAX_CHARS)).max(SLUG_LIST_MAX).optional(),
    spiceLevel: z.string().max(SLUG_MAX_CHARS).optional(),
    skipRecentDays: z.number().nullable().optional(),
  })
  .optional();

/**
 * The randomizer's one read (plan §4). Thin: validate, resolve session +
 * household, `assertMember`, delegate. All the behaviour — and all the
 * clamping — lives in `readRandomizerPool`, which the zod shape above only
 * loosely constrains (types, not the §4.1 clamps); `readRandomizerPool`
 * re-clamps everything itself via `normalizeFilters` so it is safe to call
 * directly, unvalidated, the way `randomizer.db.test.ts` does.
 */
export const getRandomizerPool = createServerFn({ method: "GET" })
  .validator((data: unknown) => filtersValidator.parse(data) ?? {})
  .handler(async ({ data }): Promise<RandomizerPool> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return readRandomizerPool(getDb(), did, householdId, data);
  });

/**
 * The body of `getRandomizerPool` — a plain exported function taking
 * `(db, did, householdId, input)`, matching `buildGroceryPreview` /
 * `readGroceryList`'s shape (`server/grocery.ts`) rather than `meal-plan.ts`'s
 * `createServerOnlyFn` wrapper, since nothing here needs the "reachable from
 * another server module without a session round trip" property those wrap
 * for — this is the terminal read of its own module.
 *
 * Deviation from the plan's §4.4 sketch: that sketch chains `.$if(cond, q =>
 * …)` throughout. This repo does not use `.$if` anywhere (verified) — the
 * established idiom is `let query = …; if (cond) query = query.where(…)`,
 * which is what the two scope branches below use instead. Same predicates,
 * same result, the repo's own idiom.
 */
export async function readRandomizerPool(db: Kysely<DB>, did: string, householdId: string, input: RandomizerFilters): Promise<RandomizerPool> {
  const { sql } = await import("kysely");
  const { householdScopedQuery } = await import("./household/scoped-query");
  const { readHouseholdPreferences } = await import("./household/preferences");

  const f = normalizeFilters(input);

  // --- §3 authorization, on BOTH scope branches -----------------------------
  //
  // The box branch below starts from `householdScopedQuery`, so the membership
  // join IS the authorization there — a non-member's join yields no row and
  // every aggregate collapses to zero. The corpus branch has no such join: it
  // scans `recipe` directly and only uses `householdId` to anti-join the box
  // and to count `skippedRecent` off `meal_plan_entry`. Without this probe a
  // caller holding any household's id would get a full corpus pool plus two
  // channels onto that household's private data — which of its recipes are
  // boxed (they go missing from the anti-join) and how many are on its plan.
  // `getRandomizerPool` already gates with `assertMember`, but §3 makes the
  // membership check a property of the READ, not of one caller, so it is
  // asserted here too and the same fail-closed empty shape the box branch
  // returns is returned for the corpus.
  if (f.source === "corpus") {
    const membership = await householdScopedQuery(db, did, householdId).select("hm.household_id").executeTakeFirst();
    if (!membership) return emptyPool("corpus");
  }

  const { timezone } = await readHouseholdPreferences(householdId);
  const today = todayIn(timezone);

  // --- scope (§4.3): source (+ collections) only, nothing else yet ---------
  //
  // `collectionIds` is applied as a correlated `EXISTS` rather than an
  // `innerJoin` on purpose: an `innerJoin` added only when collections are
  // requested would change the box query's table-alias set (`TB`) between
  // branches, which breaks the repo's `let query = …; if (cond) query =
  // query.where(…)` reassignment idiom (`AGENTS.md`: no `$if`). An `EXISTS`
  // keeps `TB` identical on both branches, so the reassignment type-checks.
  // Multiple ids are ORed via `= any(...)` over one bound array parameter —
  // never string-interpolated — inside that same single `EXISTS`, so a
  // recipe in ANY of the selected collections satisfies it once.
  // The box join (`hm`/`h`/`hr`/`r`) and the bare corpus scan (`r` only) are
  // structurally different table-alias sets — `any` is the only shape both
  // branches below can assign into one variable. Every predicate applied to
  // `scopeQuery` from here on is a raw `sql` fragment (see the module doc),
  // never a typed `eb(...)` comparison, so nothing downstream relies on this
  // looseness for correctness — only for letting one variable hold either
  // shape. Every `.execute()`/`.executeTakeFirst()` result drawn from it is
  // cast to an explicit row shape at the point it's consumed, below.
  // oxlint-disable-next-line typescript/no-explicit-any
  let scopeQuery: SelectQueryBuilder<DB, any, any>;
  if (f.source === "corpus") {
    // The public corpus, left-anti-joined against the box so widening
    // surfaces genuinely new recipes (§4.5). `collectionIds` and
    // `favoritesOnly` are box-only concepts and are silent no-ops here — a
    // public recipe not yet in anyone's box cannot belong to a household
    // collection or carry a `household_recipe.favorite` flag.
    scopeQuery = db
      .selectFrom("recipe as r")
      .where("r.visibility", "=", "public")
      .where(sql<boolean>`not exists (select 1 from household_recipe hr2 where hr2.recipe_id = r.id and hr2.household_id = ${householdId})`);
  } else {
    let box = householdScopedQuery(db, did, householdId).innerJoin("household_recipe as hr", "hr.household_id", "hm.household_id").innerJoin("recipe as r", "r.id", "hr.recipe_id");
    if (f.collectionIds.length > 0) {
      const collectionIds = f.collectionIds;
      // `rce.household_id = ${householdId}` is load-bearing, not redundant
      // with `rce.recipe_id = r.id`: without it, a recipe sitting in this
      // household's box AND in some OTHER household's collection (same
      // recipe row, two boxes) would leak in the moment that other
      // household's collection id appeared in `collectionIds` — see
      // `randomizer.db.test.ts`'s cross-household guard test.
      box = box.where(
        sql<boolean>`exists (select 1 from recipe_collection_entry rce where rce.recipe_id = r.id and rce.collection_id = any(${collectionIds}::text[]) and rce.household_id = ${householdId})`,
      );
    }
    scopeQuery = box;
  }

  // --- §4.3 aggregates, all over the SAME scope -----------------------------
  //
  // The explicit tuple cast below is the ONE place `scopeQuery`'s looseness
  // (see its declaration above) reaches into plain values — every row shape
  // here is simple and known (`{ count }` or `{ slug }` or `{ recipe_cuisine
  // }`), so this is the single, honest boundary where "trust me, Postgres
  // returned what this SELECT list says it did" is asserted, rather than
  // scattering that trust across every access below.
  const [totalRow, unenrichedRow, skippedRow, cuisineAuthorRows, cuisineLabelRows, dietRows, allergenRows, mealTypeRows, spiceRows] = (await Promise.all([
    scopeQuery.select([sql<number>`count(*)::int`.as("count")]).executeTakeFirst(),
    scopeQuery
      .leftJoin("recipe_enrichment as re", "re.recipe_id", "r.id")
      .where(sql<boolean>`(re.recipe_id is null or re.status <> 'ok')`)
      .select([sql<number>`count(*)::int`.as("count")])
      .executeTakeFirst(),
    f.skipRecentDays == null
      ? Promise.resolve({ count: 0 })
      : scopeQuery
          .where(recentPlanEntryWhere(sql, today, f.skipRecentDays, householdId))
          .select([sql<number>`count(*)::int`.as("count")])
          .executeTakeFirst(),
    scopeQuery
      .select("r.recipe_cuisine")
      .where(sql<boolean>`r.recipe_cuisine is not null`)
      .distinct()
      .execute(),
    scopeQuery
      .innerJoin("recipe_enrichment_label as l", "l.recipe_id", "r.id")
      .where(sql<boolean>`l.dimension = 'cuisine' and l.verdict = 'likely'`)
      .select("l.slug")
      .distinct()
      .execute(),
    scopeQuery
      .innerJoin("recipe_enrichment_label as l", "l.recipe_id", "r.id")
      .where(sql<boolean>`l.dimension = 'diet' and l.verdict = 'likely'`)
      .select("l.slug")
      .distinct()
      .execute(),
    scopeQuery
      .innerJoin("recipe_enrichment_label as l", "l.recipe_id", "r.id")
      .where(sql<boolean>`l.dimension = 'allergen' and l.verdict in ('contains','may_contain')`)
      .select("l.slug")
      .distinct()
      .execute(),
    scopeQuery
      .innerJoin("recipe_enrichment_label as l", "l.recipe_id", "r.id")
      .where(sql<boolean>`l.dimension = 'meal_type' and l.verdict = 'likely'`)
      .select("l.slug")
      .distinct()
      .execute(),
    scopeQuery
      .innerJoin("recipe_enrichment_label as l", "l.recipe_id", "r.id")
      .where(sql<boolean>`l.dimension = 'spice_level' and l.verdict = 'likely'`)
      .select("l.slug")
      .distinct()
      .execute(),
  ])) as [
    { count: number } | undefined,
    { count: number } | undefined,
    { count: number } | undefined,
    Array<{ recipe_cuisine: string | null }>,
    Array<{ slug: string }>,
    Array<{ slug: string }>,
    Array<{ slug: string }>,
    Array<{ slug: string }>,
    Array<{ slug: string }>,
  ];

  const totalInScope = totalRow?.count ?? 0;
  const unenrichedInScope = unenrichedRow?.count ?? 0;
  const skippedRecent = skippedRow?.count ?? 0;

  // --- §6.3 facets: slugs present in scope, labelled ------------------------
  const cuisineSlugs = new Set<string>([...cuisineAuthorRows.flatMap((row) => (row.recipe_cuisine ? [row.recipe_cuisine] : [])), ...cuisineLabelRows.map((row) => row.slug)]);
  const dietSlugs = new Set(dietRows.map((row) => row.slug).filter((slug) => !DIET_FACET_EXCLUDED.has(slug)));
  const allergenSlugs = new Set(allergenRows.map((row) => row.slug));
  const mealTypeSlugs = new Set(mealTypeRows.map((row) => row.slug));
  const spiceSlugs = new Set(spiceRows.map((row) => row.slug));

  const [cuisineLabels, dietLabels, allergenLabels, mealTypeLabels, spiceLabels] = await Promise.all([
    vocabLabels(db, "cuisine", [...cuisineSlugs]),
    vocabLabels(db, "diet", [...dietSlugs]),
    vocabLabels(db, "allergen", [...allergenSlugs]),
    vocabLabels(db, "meal_type", [...mealTypeSlugs]),
    vocabLabels(db, "spice_level", [...spiceSlugs]),
  ]);

  const facets: RandomizerFacets = {
    cuisines: labelSortedOptions(cuisineSlugs, cuisineLabels),
    diets: labelSortedOptions(dietSlugs, dietLabels),
    allergens: labelSortedOptions(allergenSlugs, allergenLabels),
    mealTypes: orderedOptions(MEAL_TYPE_ORDER, mealTypeSlugs, mealTypeLabels),
    spiceLevels: orderedOptions(SPICE_LEVEL_ORDER, spiceSlugs, spiceLabels),
  };

  // --- §4.2/§4.4/§4.6 the filtered pool --------------------------------------
  let poolQuery = scopeQuery;
  if (f.source === "box" && f.favoritesOnly) poolQuery = poolQuery.where(sql<boolean>`hr.favorite = true`);
  for (const condition of poolConditions(sql, f)) poolQuery = poolQuery.where(condition);
  if (f.skipRecentDays != null) poolQuery = poolQuery.where(notWhere(sql, recentPlanEntryWhere(sql, today, f.skipRecentDays, householdId)));

  poolQuery = poolQuery
    .leftJoin("recipe_image as img", (join) => join.onRef("img.recipe_id", "=", "r.id").on(sql<boolean>`img.ordinal = 0`))
    .leftJoin("recipe_attribution as attr", "attr.recipe_id", "r.id")
    .leftJoin("atproto_repo as repo", "repo.did", "r.did")
    .select([
      "r.id as id",
      "r.name as name",
      "r.origin as origin",
      "r.did as did",
      "r.total_time_seconds as total_time_seconds",
      "img.blob_cid as blob_cid",
      "img.blob_mime as blob_mime",
      "attr.display_name as attr_display_name",
      "attr.author as attr_author",
      "attr.publisher as attr_publisher",
      "attr.url as attr_url",
      "repo.handle as repo_handle",
    ]);

  if (f.source === "box") {
    // Small N; no pagination (§4.4) — the box is a household's own curated
    // shelf, never large enough to need a cap. Ordered by name only so the
    // rows arrive in a stable, readable order for anything that inspects the
    // pool; the draw itself is uniform over the whole array either way.
    const rows = await poolQuery.orderBy("r.name").select("hr.favorite as favorite").execute();
    return {
      source: "box",
      pool: (rows as Array<CardRow & { favorite: boolean }>).map((row) => toCard(row, row.favorite)),
      totalInScope,
      unenrichedInScope,
      skippedRecent,
      capped: false,
      cap: CORPUS_POOL_CAP,
      facets,
    };
  }

  // Corpus: cap at CORPUS_POOL_CAP and SURFACE the cap rather than truncating
  // silently (§4.5). `favorite` is always false — no `household_recipe` row
  // exists to read it from until the recipe is kept.
  //
  // `order by random()`, NOT by name, and that is the whole point of this
  // branch existing separately. The corpus is the one scope large enough to
  // hit the cap, and an alphabetical cap is a truncation that never admits to
  // being one: a public corpus of 5000 would make every recipe sorting past
  // the 200th permanently undrawable, so a randomizer would quietly refuse to
  // suggest anything after roughly the letter B. §4.5 asks only that the cap
  // be surfaced, and it is — but a surfaced cap over an alphabetical prefix
  // still answers "what should I make?" with a biased sample. Randomizing
  // here makes the capped pool a uniform sample of what matched, which is the
  // only shape the client's uniform draw over it can turn back into a uniform
  // draw over the matches.
  //
  // The cost is that two fetches of the same filters can return different
  // 200s. That is correct rather than merely tolerable: re-rolling never
  // refetches (§5.2), so within one session the pool is stable, and a
  // deliberate refetch genuinely SHOULD offer a different slice of a corpus
  // too big to show at once.
  const rows = await poolQuery
    .orderBy(sql`random()`)
    .limit(CORPUS_POOL_CAP + 1)
    .execute();
  const capped = rows.length > CORPUS_POOL_CAP;
  const page = capped ? rows.slice(0, CORPUS_POOL_CAP) : rows;
  return {
    source: "corpus",
    pool: (page as CardRow[]).map((row) => toCard(row, false)),
    totalInScope,
    unenrichedInScope,
    skippedRecent,
    capped,
    cap: CORPUS_POOL_CAP,
    facets,
  };
}
