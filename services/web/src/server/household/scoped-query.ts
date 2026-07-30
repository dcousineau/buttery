import type { Kysely } from "kysely";
import type { DB } from "#/db/types";

/**
 * Membership-join helper for household-scoped reads (§4.2). This is the pattern
 * every future private feature table (`saved_recipe`, `recipe_note`,
 * `plan_entry`, …) should be queried through, so a forgotten
 * `WHERE household_id = …` can never leak another tenant's data.
 *
 * It returns a Kysely builder that ALREADY starts from a LIVE membership:
 *   - inner-joined `household_member as hm` ↔ `household as h`
 *   - constrained to `(householdId, did)`
 *   - filtered to live rows: membership `deleted_at IS NULL AND NOT tombstoned`,
 *     household `deleted_at IS NULL`.
 *
 * Downstream you inner-join YOUR table onto `hm.household_id` and select from
 * it. Because the row only exists when the caller is a live member, the join is
 * the authorization — there is no way to select the feature row without it:
 *
 * ```ts
 * const rows = await householdScopedQuery(db, did, householdId)
 *   .innerJoin("saved_recipe as sr", "sr.household_id", "hm.household_id")
 *   .select(["sr.uri", "sr.saved_by_did"])
 *   .execute();
 * ```
 *
 * `did` MUST come from the server-validated session, never a client argument.
 *
 * NOTE: this gates on membership existence but not on ROLE. For role-gated
 * access (e.g. owners-only) call `assertMember(did, householdId, 'owner')`
 * first, or add a `.where("hm.role", "=", "owner")` clause. `assertMember`
 * remains the canonical authorization gate; this helper is the query ergonomic
 * that keeps scoped reads honest.
 */
export function householdScopedQuery(db: Kysely<DB>, did: string, householdId: string) {
  return db
    .selectFrom("household_member as hm")
    .innerJoin("household as h", "h.id", "hm.household_id")
    .where("hm.household_id", "=", householdId)
    .where("hm.did", "=", did)
    .where("hm.deleted_at", "is", null)
    .where("hm.tombstoned", "=", false)
    .where("h.deleted_at", "is", null);
}
