import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import * as z from "zod";
import type { HouseholdPreferences } from "#/lib/api/types";

/**
 * Household-wide preferences (meal planner plan §3.1 / §6.11).
 *
 * These live here rather than in `server/meal-plan.ts` because the table is
 * household-wide, not planner-owned — `week_start_day` and `timezone` are the
 * first two entries, and other features will read the same row.
 *
 * Rows are materialised LAZILY: a household with no row reads the defaults
 * below and only gets a row on its first write. That keeps household creation
 * free of preference bookkeeping and means the defaults live in exactly one
 * place at read time.
 *
 * Server-only imports (`getDb`, authz, session) are pulled in with dynamic
 * `import()` inside each handler so this module stays safe to reference from
 * the client bundle — the pattern every other server module here uses.
 */

// --- shapes -------------------------------------------------------------

/**
 * The wire DTOs this module returns are declared in the port's `types.ts` and
 * imported from there (offline plan §4.3 / §7): the client caches these shapes
 * in IndexedDB, versions them, and must be able to name them without importing
 * a server module — so it owns the declaration. Re-exported here for the
 * server-side callers that already reach for them through this module.
 */
export type { HouseholdPreferences };

/** The effective values for a household that has never saved a preference. */
export const DEFAULT_HOUSEHOLD_PREFERENCES: HouseholdPreferences = {
  weekStartDay: 1,
  timezone: "UTC",
};

// --- timezone validation -------------------------------------------------

let zoneSet: Set<string> | null = null;

/**
 * The full IANA zone list from the platform, not a curated subset (§6.11) —
 * ~400 entries, memoized because `supportedValuesOf` rebuilds the array on
 * every call.
 *
 * `Intl.supportedValuesOf` is ES2022 and present on every runtime this app
 * targets, but it is guarded anyway: if it is ever missing we accept "UTC"
 * only rather than accepting everything, so validation fails closed.
 */
export function supportedTimezones(): string[] {
  return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];
}

function isSupportedTimezone(value: string): boolean {
  if (!zoneSet) {
    zoneSet = new Set(supportedTimezones());
    // Not every platform lists plain "UTC" (some only carry "Etc/UTC"), and it
    // is our default, so it must always validate.
    zoneSet.add("UTC");
  }
  return zoneSet.has(value);
}

// --- validators ----------------------------------------------------------

const updateInput = z.object({
  weekStartDay: z.number().int().min(1).max(7),
  timezone: z.string().refine(isSupportedTimezone, { message: "Unknown time zone." }),
});

// --- helpers -------------------------------------------------------------

/**
 * Resolve the caller's DID + active household. Mirrors
 * `server/household-recipes.ts`: the household id comes from the session, never
 * from a client argument.
 */
async function activeContext(): Promise<{ did: string; householdId: string }> {
  const { getServerSession } = await import("./session");
  const { NotAMemberError } = await import("./errors");
  const { redirect } = await import("@tanstack/react-router");
  const session = await getServerSession();
  const did = session?.user.did ?? null;
  if (!did) throw redirect({ to: "/login" });
  const householdId = session?.session.active_household_id ?? null;
  if (!householdId) throw new NotAMemberError();
  return { did, householdId };
}

/**
 * Read the effective preferences for a household WITHOUT going through a server
 * function. Exported for server-side callers that already hold a household id
 * and have already authorized — `getMealPlanWeek` needs these values before it
 * can decide which week it is even looking at, and a nested server-fn call
 * would re-do the whole session round trip.
 *
 * Authorization is the caller's responsibility, which is why this takes an
 * explicit `householdId` and is not exported to the client.
 */
export const readHouseholdPreferences = createServerOnlyFn(async (householdId: string): Promise<HouseholdPreferences> => {
  const { getDb } = await import("#/lib/db");
  const row = await getDb().selectFrom("household_preference").select(["week_start_day", "timezone"]).where("household_id", "=", householdId).executeTakeFirst();
  if (!row) return { ...DEFAULT_HOUSEHOLD_PREFERENCES };
  return {
    // Defensive: the CHECK constraint keeps this in 1…7, but a value that
    // somehow got past it must not be able to break the grid.
    weekStartDay: row.week_start_day >= 1 && row.week_start_day <= 7 ? row.week_start_day : DEFAULT_HOUSEHOLD_PREFERENCES.weekStartDay,
    timezone: row.timezone,
  };
});

/**
 * Upsert the row behind `updateHouseholdPreferences`, WITHOUT the session round
 * trip. Same contract as `readHouseholdPreferences`: authorization belongs to
 * the caller, which is why the household id is explicit and this is not exposed
 * to the client.
 *
 * This is where §3.1's lazy materialisation actually happens: no row exists
 * until someone saves a preference, and then exactly one does.
 */
export const writeHouseholdPreferences = createServerOnlyFn(async (householdId: string, prefs: HouseholdPreferences): Promise<HouseholdPreferences> => {
  const { getDb } = await import("#/lib/db");
  const { sql } = await import("kysely");

  await getDb()
    .insertInto("household_preference")
    .values({ household_id: householdId, week_start_day: prefs.weekStartDay, timezone: prefs.timezone })
    .onConflict((oc) =>
      oc.column("household_id").doUpdateSet({
        week_start_day: prefs.weekStartDay,
        timezone: prefs.timezone,
        updated_at: sql`now()`,
      }),
    )
    .execute();

  return { weekStartDay: prefs.weekStartDay, timezone: prefs.timezone };
});

// --- §6.11 server functions ---------------------------------------------

/**
 * The effective preferences for the active household. Returns defaults when no
 * row exists — this never writes.
 */
export const getHouseholdPreferences = createServerFn({ method: "GET" }).handler(async (): Promise<HouseholdPreferences> => {
  const { assertMember } = await import("../authz");
  const { did, householdId } = await activeContext();
  await assertMember(did, householdId);
  return readHouseholdPreferences(householdId);
});

/**
 * Upsert both preferences. Any live member may change them (D1: role is not
 * consulted) — they are household-wide settings, not owner-only ones.
 *
 * Neither value migrates data. Changing `weekStartDay` re-buckets the same
 * date-keyed entries into different columns; changing `timezone` moves only
 * "today", the cook-mode prompt, and `.ics` event times.
 */
export const updateHouseholdPreferences = createServerFn({ method: "POST" })
  .validator((data: unknown) => updateInput.parse(data))
  .handler(async ({ data }): Promise<HouseholdPreferences> => {
    const { assertMember } = await import("../authz");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return writeHouseholdPreferences(householdId, data);
  });
