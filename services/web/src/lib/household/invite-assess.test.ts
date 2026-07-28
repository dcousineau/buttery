import { describe, expect, it } from "vitest";
import { assessInviteForAcceptance, type Invite } from "./invite-assess";
import { InviteExhausted, InviteExpired, InviteNotForYou, InviteRevoked } from "./errors";

/**
 * Ordered §6.3 acceptance validation (steps 2–5), fail-closed. Covers acceptance
 * items 4 (bound wrong-DID), 5 (open link honours max_uses/expires), 13 (revoked
 * cannot be accepted). The DB-bound steps 1/6/7 are exercised by the integration
 * test.
 */

const NOW = new Date("2026-07-28T12:00:00Z");

function invite(overrides: Partial<Invite> = {}): Invite {
  return {
    id: "01J000000000000000000INV",
    household_id: "01J000000000000000000HHH",
    created_by_did: "did:plc:owner",
    created_at: new Date("2026-07-01T00:00:00Z"),
    role: "member",
    token_hash: "deadbeef",
    bound_to_did: null,
    expires_at: null,
    max_uses: 5,
    uses: 0,
    revoked_at: null,
    status: "pending",
    ...overrides,
  };
}

describe("assessInviteForAcceptance", () => {
  it("returns null for a valid open invite", () => {
    expect(assessInviteForAcceptance(invite(), "did:plc:anyone", NOW)).toBeNull();
  });

  it("rejects a revoked invite (item 13)", () => {
    const err = assessInviteForAcceptance(invite({ revoked_at: NOW }), "did:plc:x", NOW);
    expect(err).toBeInstanceOf(InviteRevoked);
  });

  it("rejects any non-pending status as revoked (accepted/declined)", () => {
    expect(assessInviteForAcceptance(invite({ status: "accepted" }), "did:plc:x", NOW)).toBeInstanceOf(InviteRevoked);
    expect(assessInviteForAcceptance(invite({ status: "declined" }), "did:plc:x", NOW)).toBeInstanceOf(InviteRevoked);
  });

  it("rejects an expired invite (item 5)", () => {
    const err = assessInviteForAcceptance(invite({ expires_at: new Date("2026-07-28T11:59:59Z") }), "did:plc:x", NOW);
    expect(err).toBeInstanceOf(InviteExpired);
  });

  it("treats expires_at exactly at now as expired (fail closed)", () => {
    expect(assessInviteForAcceptance(invite({ expires_at: NOW }), "did:plc:x", NOW)).toBeInstanceOf(InviteExpired);
  });

  it("accepts an invite whose expiry is still in the future", () => {
    expect(assessInviteForAcceptance(invite({ expires_at: new Date("2026-07-29T00:00:00Z") }), "did:plc:x", NOW)).toBeNull();
  });

  it("rejects an exhausted invite (item 5)", () => {
    const err = assessInviteForAcceptance(invite({ uses: 5, max_uses: 5 }), "did:plc:x", NOW);
    expect(err).toBeInstanceOf(InviteExhausted);
  });

  it("rejects a bound invite presented by the wrong DID (item 4)", () => {
    const err = assessInviteForAcceptance(invite({ bound_to_did: "did:plc:target", max_uses: 1 }), "did:plc:someone-else", NOW);
    expect(err).toBeInstanceOf(InviteNotForYou);
  });

  it("accepts a bound invite presented by the correct DID", () => {
    expect(assessInviteForAcceptance(invite({ bound_to_did: "did:plc:target", max_uses: 1 }), "did:plc:target", NOW)).toBeNull();
  });

  it("checks in order: revoked beats expired beats exhausted beats bound", () => {
    // All four conditions true → the earliest (revoked) wins.
    const err = assessInviteForAcceptance(
      invite({ revoked_at: NOW, expires_at: new Date("2000-01-01T00:00:00Z"), uses: 9, max_uses: 1, bound_to_did: "did:plc:other" }),
      "did:plc:notother",
      NOW,
    );
    expect(err).toBeInstanceOf(InviteRevoked);
  });
});
