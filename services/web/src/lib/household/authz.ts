import type { Kysely, Selectable } from "kysely";
import type { DB, HouseholdMember } from "#/db/types";
import { getDb } from "#/lib/db";
import { InsufficientRoleError, NotAMemberError, type Role, roleRank } from "./errors";

/**
 * The SINGLE authorization chokepoint for every household-scoped read and write
 * (§4.1). Nothing may touch private household data without passing through here.
 *
 * `did` MUST come from the server-validated session (see
 * `src/lib/household/session.ts`) — never from a client argument. `householdId`
 * is normally `session.active_household_id`, or an explicit id for
 * cross-household operations (e.g. accepting an invite to a household you are
 * not yet active in).
 *
 * FROZEN CONTRACT: `assertMember(did, householdId, minRole?) => Promise<Membership>`.
 * Agents B and C call it with the first three args only; the optional `load`
 * parameter exists purely for testability and for callers that need a
 * transaction-bound read.
 */

/** A live membership row, exactly as selected from `household_member`. */
export type Membership = Selectable<HouseholdMember>;

/**
 * Fetches the LIVE membership for `(householdId, did)` whose parent household is
 * also live, or `undefined` if there is none. "Live" = membership
 * `deleted_at IS NULL AND NOT tombstoned` and household `deleted_at IS NULL`.
 *
 * Exported so callers can run it against a transaction (`loadLiveMembership(did,
 * householdId, trx)`) and reuse the exact liveness predicate.
 */
export async function loadLiveMembership(did: string, householdId: string, db: Kysely<DB> = getDb()): Promise<Membership | undefined> {
  return db
    .selectFrom("household_member as hm")
    .innerJoin("household as h", "h.id", "hm.household_id")
    .where("hm.household_id", "=", householdId)
    .where("hm.did", "=", did)
    .where("hm.deleted_at", "is", null)
    .where("hm.tombstoned", "=", false)
    .where("h.deleted_at", "is", null)
    .select(["hm.household_id", "hm.did", "hm.role", "hm.joined_at", "hm.invited_by_did", "hm.deleted_at", "hm.tombstoned"])
    .executeTakeFirst();
}

/** Loads a live membership. Injectable so `assertMember` is unit-testable. */
export type MembershipLoader = (did: string, householdId: string) => Promise<Membership | undefined>;

/**
 * Assert that `did` is a live member of `householdId` with at least `minRole`,
 * returning the membership row.
 *
 * @throws {NotAMemberError}      no live membership in a live household
 * @throws {InsufficientRoleError} member's role rank is below `minRole`
 */
export async function assertMember(did: string, householdId: string, minRole: Role = "member", load: MembershipLoader = loadLiveMembership): Promise<Membership> {
  const membership = await load(did, householdId);
  if (!membership) {
    throw new NotAMemberError();
  }
  if (roleRank(membership.role) < roleRank(minRole)) {
    throw new InsufficientRoleError();
  }
  return membership;
}
