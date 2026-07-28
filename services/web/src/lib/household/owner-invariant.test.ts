import { describe, expect, it } from "vitest";
import { wouldDropLastOwner } from "./owner-invariant";

/**
 * Owner-invariant guard (§7.1, acceptance items 8 & 9). Pure — the DB caller
 * feeds it the live-owner DID set; this decides whether removing/demoting one
 * would leave zero owners.
 */
describe("wouldDropLastOwner", () => {
  it("blocks removing the sole owner (item 8)", () => {
    expect(wouldDropLastOwner(["did:plc:a"], "did:plc:a")).toBe(true);
  });

  it("allows one owner to leave when another owner remains (item 9)", () => {
    expect(wouldDropLastOwner(["did:plc:a", "did:plc:b"], "did:plc:a")).toBe(false);
  });

  it("allows removing a member (not in the owner set) even with a single owner", () => {
    // A member removal never touches the owner set → never trips the invariant.
    expect(wouldDropLastOwner(["did:plc:a"], "did:plc:member")).toBe(false);
  });

  it("treats an already-ownerless household as tripping the guard", () => {
    expect(wouldDropLastOwner([], "did:plc:a")).toBe(true);
  });

  it("is robust to duplicate DIDs in the owner set", () => {
    expect(wouldDropLastOwner(["did:plc:a", "did:plc:a"], "did:plc:a")).toBe(true);
    expect(wouldDropLastOwner(["did:plc:a", "did:plc:a", "did:plc:b"], "did:plc:a")).toBe(false);
  });
});
