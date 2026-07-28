/**
 * Typed error set for the households feature (§9 of
 * `docs/plans/02-households-and-private-foundation.md`).
 *
 * Every household server function branches on these so it can map a failure to
 * the right HTTP status / UI affordance without string-matching messages.
 * Discrimination is available two ways:
 *   - `err instanceof HouseholdError` (and the specific subclasses), and
 *   - `err.code` — a stable string literal, safe to serialize to the client.
 *
 * `httpStatus` is a suggested mapping; a server function may override it, but
 * keeping it here means the common case ("translate to a Response") is one read.
 *
 * These names are a FROZEN CONTRACT — agents B and C import them verbatim. Do
 * not rename exports or `code` strings.
 */

/** Membership roles. Free text in the DB, but these are the only ranked values. */
export type Role = "owner" | "member";

/**
 * Role rank for `assertMember`'s `minRole` gating: `owner (2) > member (1)`.
 * Unknown/future roles rank `0` (below `member`) so gating fails CLOSED for a
 * role we don't yet understand.
 */
export const ROLE_RANK: Record<Role, number> = {
  owner: 2,
  member: 1,
};

/** Rank of any role string, defaulting unknown roles to 0 (fail-closed). */
export function roleRank(role: string): number {
  return (ROLE_RANK as Record<string, number>)[role] ?? 0;
}

/** Stable, client-safe discriminators for every household error. */
export type HouseholdErrorCode =
  | "not_a_member"
  | "insufficient_role"
  | "invalid_invite"
  | "invite_expired"
  | "invite_exhausted"
  | "invite_not_for_you"
  | "invite_revoked"
  | "invite_household_gone"
  | "last_owner";

/** Base class for every typed household error. `instanceof`-discriminable. */
export abstract class HouseholdError extends Error {
  /** Stable machine code — safe to send to the client and switch on. */
  abstract readonly code: HouseholdErrorCode;
  /** Suggested HTTP status for a server function translating this to a Response. */
  abstract readonly httpStatus: number;

  constructor(message?: string) {
    super(message);
    // Set the runtime name to the concrete subclass (e.g. "NotAMemberError").
    this.name = new.target.name;
    // Preserve prototype chain across the ES5 `extends Error` transpile so
    // `instanceof` keeps working under the compiled output.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// --- Authorization (§4) -------------------------------------------------

/** Caller has no LIVE membership in the (live) household. → onboarding / 403. */
export class NotAMemberError extends HouseholdError {
  readonly code = "not_a_member" as const;
  readonly httpStatus = 403;
  constructor(message = "You are not a member of this household.") {
    super(message);
  }
}

/** Caller is a member but their role rank is below the required `minRole`. */
export class InsufficientRoleError extends HouseholdError {
  readonly code = "insufficient_role" as const;
  readonly httpStatus = 403;
  constructor(message = "You do not have permission to perform this action.") {
    super(message);
  }
}

// --- Invite lifecycle (§6.3) --------------------------------------------

/** Presented token does not hash to any invite. */
export class InvalidInvite extends HouseholdError {
  readonly code = "invalid_invite" as const;
  readonly httpStatus = 404;
  constructor(message = "This invite link is not valid.") {
    super(message);
  }
}

/** Invite has passed its `expires_at`. */
export class InviteExpired extends HouseholdError {
  readonly code = "invite_expired" as const;
  readonly httpStatus = 410;
  constructor(message = "This invite has expired.") {
    super(message);
  }
}

/** Invite has reached `max_uses`. */
export class InviteExhausted extends HouseholdError {
  readonly code = "invite_exhausted" as const;
  readonly httpStatus = 410;
  constructor(message = "This invite has already been used the maximum number of times.") {
    super(message);
  }
}

/** A bound invite was presented by a DID other than `bound_to_did`. */
export class InviteNotForYou extends HouseholdError {
  readonly code = "invite_not_for_you" as const;
  readonly httpStatus = 403;
  constructor(message = "This invite was issued for a different account.") {
    super(message);
  }
}

/** Invite was revoked by an owner (or is otherwise no longer pending). */
export class InviteRevoked extends HouseholdError {
  readonly code = "invite_revoked" as const;
  readonly httpStatus = 410;
  constructor(message = "This invite is no longer active.") {
    super(message);
  }
}

/** The invite's parent household has been deleted (§6.3 step 6). */
export class InviteHouseholdGone extends HouseholdError {
  readonly code = "invite_household_gone" as const;
  readonly httpStatus = 410;
  constructor(message = "The household this invite points to no longer exists.") {
    super(message);
  }
}

// --- Owner invariant (§7.1) ---------------------------------------------

/** Blocked: the action would leave a live household with zero live owners. */
export class LastOwnerError extends HouseholdError {
  readonly code = "last_owner" as const;
  readonly httpStatus = 409;
  constructor(message = "Promote another owner or delete the household first.") {
    super(message);
  }
}
