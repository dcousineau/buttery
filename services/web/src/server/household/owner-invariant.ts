/**
 * PURE owner-invariant guard (§7.1).
 *
 * The rule: a live household must never drop below one live `owner`. It is
 * enforced by *leave*, *remove member*, and *demote owner* — each of which
 * removes exactly one DID from the live-owner set. This function answers the
 * single question those three share, so it's unit-testable without a database:
 * given the current live-owner DIDs, would taking `affectedDid` out of the owner
 * set leave zero owners?
 *
 * The DB caller supplies `currentOwnerDids` from a `SELECT did FROM
 * household_member WHERE role='owner' AND deleted_at IS NULL AND NOT tombstoned`
 * run INSIDE the mutating transaction, then throws `LastOwnerError` when this
 * returns true.
 */
export function wouldDropLastOwner(currentOwnerDids: string[], affectedDid: string): boolean {
  // De-dup defensively; `(household_id, did)` is a PK so this is normally a no-op.
  const remaining = new Set(currentOwnerDids.filter((did) => did !== affectedDid));
  return remaining.size === 0;
}
