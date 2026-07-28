import { describe, expect, it } from "vitest";
import { generateInviteToken, hashInviteToken } from "./invite-token";

/**
 * Pure token tests (acceptance item 15: raw tokens never touch the DB). We can't
 * inspect the DB here, but we CAN prove the property the storage rule depends on:
 * the stored value is a hash, distinct from and not reversible to the token.
 */
describe("invite-token", () => {
  it("generates high-entropy, URL-safe tokens", () => {
    const t = generateInviteToken();
    // 32 bytes → 43 base64url chars (no padding), only URL-safe alphabet.
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(43);
  });

  it("generates a unique token each call", () => {
    const set = new Set(Array.from({ length: 100 }, () => generateInviteToken()));
    expect(set.size).toBe(100);
  });

  it("hashes to a stable 64-char hex sha256 that never equals the token", () => {
    const t = generateInviteToken();
    const h1 = hashInviteToken(t);
    const h2 = hashInviteToken(t);
    expect(h1).toBe(h2); // stable — lookups by hash work
    expect(h1).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    expect(h1).not.toBe(t); // never store the raw token
  });

  it("distinct tokens hash to distinct values", () => {
    expect(hashInviteToken(generateInviteToken())).not.toBe(hashInviteToken(generateInviteToken()));
  });
});
