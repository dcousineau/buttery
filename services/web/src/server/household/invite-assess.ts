import type { Selectable } from "kysely";
import type { HouseholdInvite } from "#/db/types";
import { InviteExhausted, InviteExpired, InviteNotForYou, InviteRevoked, type HouseholdError } from "./errors";

/**
 * PURE invite-acceptance assessment (§6.3, steps 2–5).
 *
 * `acceptInvite` performs the DB-bound steps around this — (1) hash→invite
 * lookup, (6) parent-household liveness, (7) already-a-member idempotency — but
 * the ordered *validity* checks that need only the invite row + caller DID + now
 * live here so every failure branch is unit-testable without a database.
 *
 * Ordering is load-bearing and fails CLOSED: revoked → expired → exhausted →
 * bound-mismatch. Returns the typed error to throw, or `null` when the invite is
 * acceptable so far.
 */

export type Invite = Selectable<HouseholdInvite>;

/**
 * Step 2: an invite is no longer acceptable once it's been revoked OR has left
 * the `pending` state (accepted/declined/revoked). The plan maps this whole
 * "not pending" bucket to `InviteRevoked` ("no longer active").
 */
export function isRevoked(invite: Invite): boolean {
  return invite.revoked_at !== null || invite.status !== "pending";
}

/** Step 3: expired iff it has an `expires_at` at or before `now`. */
export function isExpired(invite: Invite, now: Date): boolean {
  if (invite.expires_at === null) return false;
  return new Date(invite.expires_at).getTime() <= now.getTime();
}

/** Step 4: exhausted once `uses` has reached `max_uses`. */
export function isExhausted(invite: Invite): boolean {
  return invite.uses >= invite.max_uses;
}

/**
 * Steps 2–5 in order. `sessionDid` is the server-validated caller DID. Returns
 * the error to throw, or `null` if the invite passes these checks.
 */
export function assessInviteForAcceptance(invite: Invite, sessionDid: string, now: Date): HouseholdError | null {
  if (isRevoked(invite)) return new InviteRevoked();
  if (isExpired(invite, now)) return new InviteExpired();
  if (isExhausted(invite)) return new InviteExhausted();
  // Step 5: a bound invite may only be accepted by its target DID. An open
  // invite (`bound_to_did === null`) skips this.
  if (invite.bound_to_did !== null && invite.bound_to_did !== sessionDid) {
    return new InviteNotForYou();
  }
  return null;
}
