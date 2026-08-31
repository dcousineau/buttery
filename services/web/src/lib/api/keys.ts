/**
 * The query-key namespace (offline plan §4.2).
 *
 * Two jobs, and the second is why the shape is so deliberate:
 *
 * 1. **Cache partitioning.** Every household-scoped key carries its `householdId`.
 *    The server derives the active household from `session.active_household_id`
 *    and never accepts it as an argument (`src/server/recipe-context.ts`) — that
 *    does not change. But the *client* must know which household a cached row
 *    belongs to, or switching households serves one household's recipes to
 *    another. So `householdId` appears in every key and in no validator (§2.4).
 *    It is a partition, never an authorization input.
 *
 * 2. **The future URL namespace.** Each key is the REST path it will become when
 *    the API service in §7 is extracted, spelled as an array. Keeping the two in
 *    step now is free; retrofitting it later is the expensive part of that
 *    extraction. The mapping is written out in the plan's §4.2 table.
 *
 * Keys are `as const` tuples so prefix invalidation is exact and typo-proof:
 * `invalidateQueries({ queryKey: keys.household.grocery(hid) })` touches the
 * grocery list and nothing else, and `keys.household.all(hid)` is the whole
 * partition — which is what a household switch wipes.
 *
 * The full namespace is defined even though only the `household` rows are
 * consumed by a migrated route today (§4.1): an un-migrated route adopts its
 * reserved key the day it crosses the boundary, and reserving them here is what
 * stops two routes from inventing two spellings of the same resource.
 */

import type { PlanDate } from "#/lib/plan/week";

/** A household id, as it appears in a key. Never sent to the server. */
type HouseholdId = string;

export const keys = {
  /** Caller-scoped, household-independent. Survives a household switch. */
  me: {
    households: () => ["me", "households"] as const,
  },

  household: {
    /** The whole partition for one household — the prefix a switch/wipe targets. */
    all: (hid: HouseholdId) => ["household", hid] as const,
    recipes: (hid: HouseholdId) => ["household", hid, "recipes"] as const,
    recipe: (hid: HouseholdId, recipeId: string) => ["household", hid, "recipes", recipeId] as const,
    /**
     * One week of the plan. `undefined` means "whatever the server calls this
     * week" and is spelled `"current"` rather than left as a hole in the tuple.
     *
     * **Two keys can hold the same week, and nothing here can prevent it.**
     * Only the server can map `undefined` onto a real week start — it depends on
     * the household's timezone and week-start day (`getMealPlanWeek`), which the
     * client would have to duplicate to canonicalize the key. So `/household/plan`
     * and `/household/plan?week=<that same Monday>` are two entries over one
     * week of server data. That is a duplicate read, which is cheap.
     *
     * What is *not* cheap is invalidating only one of them: a meal deleted under
     * `?week=X` that touched only `plan(hid, X)` leaves the `"current"` entry
     * still holding the deleted meal, and clicking "Today" inside `staleTime`
     * puts it back on screen. Every plan write therefore invalidates
     * {@link planAll} rather than the exact key it was built with (offline plan
     * §4.2) — one week is one entry as far as staleness is concerned, even when
     * it is stored twice.
     */
    plan: (hid: HouseholdId, week: PlanDate | undefined) => ["household", hid, "plan", week ?? "current"] as const,
    /** Every plan week in one household — the prefix every plan write invalidates. */
    planAll: (hid: HouseholdId) => ["household", hid, "plan"] as const,
    grocery: (hid: HouseholdId) => ["household", hid, "grocery"] as const,
    /**
     * Every collection in the household, membership included — one entry, not
     * one per collection. `listCollections` is a single small read that the
     * chips, the counts, the picker and the scoped ledger all derive from
     * (collections plan §5), so splitting it per collection would buy nothing
     * and cost a fan-out of invalidations on every reorder.
     */
    collections: (hid: HouseholdId) => ["household", hid, "collections"] as const,
    members: (hid: HouseholdId) => ["household", hid, "members"] as const,
    preferences: (hid: HouseholdId) => ["household", hid, "preferences"] as const,
    /**
     * One randomizer pool read, keyed by its filters (meal randomizer plan
     * §4). Unlike every other row in this namespace, a query built on this
     * key is deliberately NOT offline-capable — `randomizerPoolQuery`
     * (`queries.ts`) opts itself out of the persister, because the pool must
     * fail like the app's other online-only surfaces (plan §1.2) rather than
     * serve a stale draw pool from a household that has since changed its
     * box. `filters` is JSON-stringified into the key (rather than spread as
     * individual tuple entries) because its field set is open-ended — a new
     * filter added later must not require a matching edit here.
     */
    randomizer: (hid: HouseholdId, filters: unknown) => ["household", hid, "randomizer", JSON.stringify(filters ?? {})] as const,
  },

  /** The public browse/search surface. Not household-scoped, not yet migrated. */
  recipes: {
    recent: () => ["recipes", "public", "recent"] as const,
    detail: (recipeId: string) => ["recipes", "public", recipeId] as const,
  },

  search: {
    global: (q: string, cursor: string | null) => ["search", "global", q, cursor] as const,
  },
} as const;

/**
 * The session snapshot is *not* in this namespace.
 *
 * It is root-level, it must answer offline before any household is known, and it
 * is read through `authClient` rather than through a `queryOptions` factory — so
 * it gets its own key in `src/lib/offline/session-cache.ts` rather than a
 * partitioned query key. §4.4 spells out why it fails *open* rather than
 * blocking the shell.
 */
export const OFFLINE_FALLBACK_KEYS = {
  session: "buttery:offline:session",
} as const;
