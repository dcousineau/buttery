import { describe, expect, it } from "vitest";
import { assertMember, type Membership, type MembershipLoader } from "./authz";
import { InsufficientRoleError, NotAMemberError } from "./household/errors";

/**
 * Unit tests for the §4.1 authorization chokepoint. The DB is not reachable
 * from this environment, so we inject a fake `MembershipLoader` that replicates
 * the LIVE-membership predicate `loadLiveMembership` runs in Postgres
 * (membership `deleted_at IS NULL AND NOT tombstoned`, parent household
 * `deleted_at IS NULL`). This exercises `assertMember`'s branching for the four
 * §16 outcomes without a database.
 *
 * The real query is covered by an integration test once a dev DB is reachable
 * (`railway run --service buttery -- ...`); see the plan's Agent B slice.
 */

type MemberRow = Membership & { household_deleted: boolean };

function member(overrides: Partial<MemberRow> & Pick<MemberRow, "household_id" | "did" | "role">): MemberRow {
  return {
    joined_at: new Date("2026-01-01T00:00:00Z"),
    invited_by_did: null,
    deleted_at: null,
    tombstoned: false,
    autoimport_my_recipes: true,
    household_deleted: false,
    ...overrides,
  };
}

/** A loader over an in-memory row set, applying the same liveness predicate. */
function makeLoader(rows: MemberRow[]): MembershipLoader {
  return (did, householdId) => {
    const row = rows.find((r) => r.household_id === householdId && r.did === did && r.deleted_at === null && !r.tombstoned && !r.household_deleted);
    if (!row) return Promise.resolve(undefined);
    // Strip the test-only `household_deleted` flag; return a clean Membership.
    const { household_deleted: _ignored, ...membership } = row;
    return Promise.resolve(membership);
  };
}

const OWNER = "did:plc:owner";
const MEMBER = "did:plc:member";
const STRANGER = "did:plc:stranger";
const REMOVED = "did:plc:removed";
const GHOST = "did:plc:ghost";

const LIVE_HH = "hh_live";
const DEAD_HH = "hh_dead";

const rows: MemberRow[] = [
  member({ household_id: LIVE_HH, did: OWNER, role: "owner" }),
  member({ household_id: LIVE_HH, did: MEMBER, role: "member" }),
  member({ household_id: LIVE_HH, did: REMOVED, role: "member", deleted_at: new Date() }),
  member({ household_id: DEAD_HH, did: GHOST, role: "owner", household_deleted: true }),
];
const load = makeLoader(rows);

describe("assertMember", () => {
  it("returns the membership for a live member (default minRole 'member')", async () => {
    const membership = await assertMember(MEMBER, LIVE_HH, "member", load);
    expect(membership.did).toBe(MEMBER);
    expect(membership.role).toBe("member");
    expect(membership.household_id).toBe(LIVE_HH);
  });

  it("returns the membership for an owner meeting an 'owner' minRole", async () => {
    const membership = await assertMember(OWNER, LIVE_HH, "owner", load);
    expect(membership.role).toBe("owner");
  });

  it("throws InsufficientRoleError when a member is gated to 'owner'", async () => {
    await expect(assertMember(MEMBER, LIVE_HH, "owner", load)).rejects.toBeInstanceOf(InsufficientRoleError);
    await expect(assertMember(MEMBER, LIVE_HH, "owner", load)).rejects.toMatchObject({ code: "insufficient_role" });
  });

  it("throws NotAMemberError when the caller has no membership", async () => {
    await expect(assertMember(STRANGER, LIVE_HH, "member", load)).rejects.toBeInstanceOf(NotAMemberError);
    await expect(assertMember(STRANGER, LIVE_HH, "member", load)).rejects.toMatchObject({ code: "not_a_member" });
  });

  it("throws NotAMemberError when the membership is soft-deleted (removed/left)", async () => {
    await expect(assertMember(REMOVED, LIVE_HH, "member", load)).rejects.toBeInstanceOf(NotAMemberError);
  });

  it("throws NotAMemberError when the parent household is soft-deleted (stale active)", async () => {
    await expect(assertMember(GHOST, DEAD_HH, "member", load)).rejects.toBeInstanceOf(NotAMemberError);
  });

  it("defaults minRole to 'member' so a member passes with no minRole given", async () => {
    const membership = await assertMember(MEMBER, LIVE_HH, undefined, load);
    expect(membership.did).toBe(MEMBER);
  });
});
